import asyncio
import os
import unittest
from unittest.mock import patch

from backend.api_guard import APIGuard, MAX_BODY_BYTES, extension_origin_pattern


class GuardTests(unittest.IsolatedAsyncioTestCase):
    async def request(self, guard, *, chunks=(b'{}',), headers=(), path='/predict', method='POST', client='1.2.3.4'):
        messages = iter({'type': 'http.request', 'body': chunk, 'more_body': index < len(chunks) - 1}
                        for index, chunk in enumerate(chunks))
        output = []

        async def receive():
            return next(messages)

        async def send(message):
            output.append(message)

        await guard({'type': 'http', 'method': method, 'path': path,
                     'headers': list(headers), 'client': (client, 123)}, receive, send)
        return output

    async def echo(self, scope, receive, send):
        message = await receive()
        await send({'type': 'http.response.start', 'status': 200})
        await send({'type': 'http.response.body', 'body': message['body']})

    async def test_valid_chunked_body_reaches_app_intact(self):
        guard = APIGuard(self.echo)
        output = await self.request(guard, chunks=(b'{"te', b'xt":"ok"}'))
        self.assertEqual(output[0]['status'], 200)
        self.assertEqual(output[1]['body'], b'{"text":"ok"}')
        self.assertEqual(guard.active, 0)

    async def test_oversized_chunked_body_is_rejected_even_with_false_length(self):
        guard = APIGuard(self.echo)
        output = await self.request(guard, chunks=(b'x' * MAX_BODY_BYTES, b'x'),
                                    headers=((b'content-length', b'1'),))
        self.assertEqual(output[0]['status'], 413)
        self.assertEqual(guard.active, 0)

    async def test_foreign_web_origin_is_rejected_before_inference(self):
        output = await self.request(APIGuard(self.echo), headers=((b'origin', b'https://evil.example'),))
        self.assertEqual(output[0]['status'], 403)
        with patch.dict(os.environ, {'ABSA_EXTENSION_IDS': 'a' * 32}):
            guard = APIGuard(self.echo)
        allowed = await self.request(guard, headers=((b'origin', b'chrome-extension://' + b'a' * 32),))
        denied = await self.request(guard, headers=((b'origin', b'chrome-extension://' + b'b' * 32),))
        self.assertEqual(allowed[0]['status'], 200)
        self.assertEqual(denied[0]['status'], 403)

    async def test_rate_limit_cannot_be_bypassed_by_forwarded_headers(self):
        guard = APIGuard(self.echo, requests_per_minute=1)
        self.assertEqual((await self.request(guard))[0]['status'], 200)
        denied = await self.request(guard, headers=((b'x-forwarded-for', b'8.8.8.8'),))
        self.assertEqual(denied[0]['status'], 429)
        self.assertIn(b'retry-after', dict(denied[0]['headers']))
        self.assertEqual((await self.request(guard, client='5.6.7.8'))[0]['status'], 200)
        with patch('backend.api_guard.monotonic', return_value=10**12):
            self.assertEqual((await self.request(guard))[0]['status'], 200)

    async def test_overload_does_not_block_health_and_capacity_is_released(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def slow_app(scope, receive, send):
            if scope['path'] == '/predict':
                entered.set()
                await release.wait()
            await self.echo(scope, receive, send)

        guard = APIGuard(slow_app, max_predictions=1)
        first = asyncio.create_task(self.request(guard))
        await entered.wait()
        try:
            self.assertEqual((await self.request(guard, path='/predict/batch'))[0]['status'], 503)
            self.assertEqual((await self.request(guard, path='/health', method='GET'))[0]['status'], 200)
        finally:
            release.set()
            await first
        self.assertEqual(guard.active, 0)
        self.assertEqual((await self.request(guard))[0]['status'], 200)

    async def test_disconnect_releases_capacity(self):
        async def disconnected():
            return {'type': 'http.disconnect'}

        guard = APIGuard(self.echo)
        await guard({'type': 'http', 'method': 'POST', 'path': '/predict'}, disconnected, None)
        self.assertEqual(guard.active, 0)

    async def test_body_timeout_releases_all_capacity(self):
        guard = APIGuard(self.echo)
        with patch('backend.api_guard.monotonic', side_effect=[0, 0, 31]):
            self.assertEqual((await self.request(guard))[0]['status'], 408)
        self.assertEqual((guard.active, guard.posts), (0, 0))

    async def test_log_posts_have_a_global_limit_too(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def waiting(scope, receive, send):
            if scope['method'] == 'POST':
                entered.set()
                await release.wait()
            await self.echo(scope, receive, send)

        guard = APIGuard(waiting, max_posts=1)
        first = asyncio.create_task(self.request(guard, path='/activity/log'))
        await entered.wait()
        try:
            self.assertEqual((await self.request(guard, path='/activity/log'))[0]['status'], 503)
            self.assertEqual((await self.request(guard, path='/health', method='GET'))[0]['status'], 200)
        finally:
            release.set()
            await first
        self.assertEqual(guard.posts, 0)

    async def test_application_failure_releases_capacity(self):
        async def broken(*args):
            raise RuntimeError('test')

        guard = APIGuard(broken)
        with self.assertRaises(RuntimeError):
            await self.request(guard)
        self.assertEqual((guard.active, guard.posts), (0, 0))

    def test_invalid_extension_configuration_fails_closed(self):
        with patch.dict(os.environ, {'ABSA_EXTENSION_IDS': 'invalid'}), self.assertRaises(ValueError):
            extension_origin_pattern()

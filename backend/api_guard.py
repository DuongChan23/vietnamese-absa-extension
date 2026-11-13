"""Bound public API work before JSON parsing or entering the model thread pool."""

from collections import OrderedDict
from asyncio import TimeoutError, wait_for
import json
import os
import re
from time import monotonic

MAX_BODY_BYTES = 1024 * 1024
PREDICTION_PATHS = {'/predict', '/predict/batch'}


def extension_origin_pattern():
    ids = os.getenv('ABSA_EXTENSION_IDS', '').split()
    if any(not re.fullmatch(r'[a-p]{32}', value) for value in ids):
        raise ValueError('ABSA_EXTENSION_IDS must contain space-separated Chrome extension IDs')
    return r'^chrome-extension://(' + '|'.join(ids or [r'[a-p]{32}']) + r')$'


class APIGuard:
    def __init__(self, app, *, max_predictions=4, max_posts=32, requests_per_minute=120):
        self.app = app
        self.max_predictions = max_predictions
        self.requests_per_minute = requests_per_minute
        self.origin = re.compile(extension_origin_pattern())
        self.clients = OrderedDict()
        self.active = 0
        self.posts = 0
        self.max_posts = max_posts

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope['method'] != 'POST':
            return await self.app(scope, receive, send)
        headers = dict(scope.get('headers', []))
        origin = headers.get(b'origin')
        if origin and not self.origin.fullmatch(origin.decode('latin-1')):
            return await self.reject(send, 403, 'origin_not_allowed')

        # Use the peer supplied by Uvicorn, never arbitrary client headers.
        client = (scope.get('client') or ('unknown', 0))[0]
        now = monotonic()
        expires, count = self.clients.pop(client, (now + 60, 0))
        if now >= expires:
            expires, count = now + 60, 0
        self.clients[client] = (expires, count + 1)
        if len(self.clients) > 4096:
            self.clients.popitem(last=False)
        if count >= self.requests_per_minute:
            return await self.reject(send, 429, 'rate_limit_exceeded', max(1, int(expires - now) + 1))

        prediction = scope['path'].rstrip('/') in PREDICTION_PATHS
        if self.posts >= self.max_posts or (prediction and self.active >= self.max_predictions):
            return await self.reject(send, 503, 'server_busy', 5)
        self.posts += 1
        if prediction:
            self.active += 1
        try:
            # Count actual chunks; Content-Length alone misses chunked requests.
            body = bytearray()
            deadline = monotonic() + 30
            while True:
                try:
                    message = await wait_for(receive(), timeout=max(0, deadline - monotonic()))
                except TimeoutError:
                    return await self.reject(send, 408, 'request_timeout')
                if message['type'] == 'http.disconnect':
                    return
                body.extend(message.get('body', b''))
                if len(body) > MAX_BODY_BYTES:
                    return await self.reject(send, 413, 'request_too_large')
                if not message.get('more_body', False):
                    break

            async def replay():
                nonlocal body
                if body is None:
                    return await receive()
                message = {'type': 'http.request', 'body': bytes(body), 'more_body': False}
                body = None
                return message

            await self.app(scope, replay, send)
        finally:
            self.posts -= 1
            if prediction:
                self.active -= 1

    @staticmethod
    async def reject(send, status, detail, retry_after=None):
        body = json.dumps({'detail': detail}).encode()
        headers = [(b'content-type', b'application/json'), (b'content-length', str(len(body)).encode())]
        if retry_after is not None:
            headers.append((b'retry-after', str(retry_after).encode()))
        await send({'type': 'http.response.start', 'status': status, 'headers': headers})
        await send({'type': 'http.response.body', 'body': body})

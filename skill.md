
---
name: shopee-absa-extension
description: Develop, modify, debug and maintain the Vietnamese ABSA Shopee Chrome Extension using Chrome Manifest V3, Side Panel, JavaScript and FastAPI. Use whenever working on the Shopee review collector, extension UI, background service worker, API integration, ABSA analytics or export functionality.
---
# Shopee Vietnamese ABSA Extension

## 1. Project overview

This project is a local Vietnamese Aspect-Based Sentiment Analysis
(ABSA) system for Shopee product reviews.

Architecture:

Chrome Extension (Manifest V3)
    -> Chrome Side Panel
    -> Background Service Worker
    -> Shopee Review Collector
    -> Local FastAPI Backend
    -> ABSA Inference Pipeline
    -> Analytics and Results Display

Backend API:
http://127.0.0.1:8000

## 2. Technology stack

Frontend:

- JavaScript
- HTML
- CSS
- Chrome Extension Manifest V3
- Chrome Side Panel API
- Chrome Runtime Messaging API

Backend:

- Python
- FastAPI
- Local inference pipeline
- VnCoreNLP

Models:

- NB39: XLM-R Joint Biaffine
- NB46: Boundary Reranker
- NB04: PhoBERT Sentiment Classification

## 3. Development rules

- Inspect the existing project structure before changing code.
- Understand the execution flow before modifying a component.
- Preserve the existing architecture unless explicitly requested.
- Prefer minimal, targeted changes.
- Avoid unnecessary dependencies.
- Follow JavaScript and Python coding conventions.
- Handle errors and loading states explicitly.
- Avoid hardcoding API responses or test data in production code.

## 4. Chrome Extension rules

- Follow Chrome Manifest V3.
- Maintain compatibility with Chrome Side Panel.
- Keep background service worker responsibilities clear.
- Handle message passing between components correctly.
- Check permissions and host permissions before changing manifest.json.
- Prevent duplicate event listeners.
- Handle tab changes and side panel lifecycle.
- Preserve existing Shopee review collection functionality.
- Avoid unnecessary DOM manipulation.
- Handle missing or changing Shopee page elements gracefully.

## 5. Backend integration

- Keep model inference inside FastAPI.
- Do not move model checkpoints into the browser.
- Preserve existing API contracts.
- Validate request and response data.
- Handle backend unavailable, timeout and invalid response cases.
- Do not change model architecture or checkpoints unless explicitly requested.

## 6. Important constraints

For tasks focused on Extension UI or Side Panel:

- Only modify files inside extension/.
- Do not modify backend/, models/, .venv/ or vncorenlp/.
- Do not alter ABSA algorithms.
- Do not replace working functionality without evidence of a bug.

For backend tasks:

- Modify only the necessary backend components.
- Preserve compatibility with the Extension API.

## 7. Testing requirements

After every meaningful change:

1. Inspect changed files.
2. Check JavaScript syntax.
3. Verify Manifest V3 configuration.
4. Test extension loading in Chrome.
5. Test Side Panel opening and interaction.
6. Test communication between extension components.
7. Test FastAPI connectivity when API integration changes.
8. Check regression in Shopee review collection.
9. Report test results and remaining issues.

Never claim a feature works without verification.

## 8. Security

- Apply least-privilege permissions.
- Do not expose API keys or credentials.
- Validate messages and API inputs.
- Avoid sending collected review data to unauthorized external services.
- Keep backend local unless explicitly configured otherwise.

## 9. Working methodology

Before implementation:

1. Understand the requested change.
2. Inspect related source files.
3. Identify dependencies and possible regressions.
4. Propose a minimal implementation plan.

After implementation:

1. Explain changed files.
2. Explain technical changes.
3. Run relevant tests.
4. Report verified results.
5. List remaining limitations.

# Contributing to Drishtikit

Thank you for your interest. Phase 1 (usage analytics) is built and not published yet.

- **Ideas and questions:** open an issue. Tell us what you want to do and why.
- **Code:** open an issue first, so we agree on the change before you write it.
- **Style:** TypeScript, small pure functions in `@drishtikit/core`, tests for each change.
- **Privacy:** a change must not record page text, typed text, query strings, request bodies or IP addresses.
- **Writing:** documentation uses short, simple sentences (ASD-STE100 style).

Issues are welcome, but we cannot promise support or a reply time.

## Work on the code

```sh
npm install
npm run build
npm run lint
npm test
```

Tests need no database. They use `mongodb-memory-server`. Add a changeset (`npx changeset`) for a change that users can see.

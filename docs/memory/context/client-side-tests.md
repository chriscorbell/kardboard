# Testing client code

Read when: a card changes behaviour in `packages/app/client` and the change needs a test.

Status: verified
Scope: component, `packages/app`
Verified: 2026-09-24
Source: `packages/app/package.json`, `packages/app/tsconfig.client-test.json`, `packages/app/client/test/composerKeys.test.ts`, `packages/app/client/test/dropPlacement.test.ts`
Recheck when: the `test` or `typecheck` script in `packages/app/package.json` changes, or a DOM test harness is added

There is no DOM test harness — no jsdom, no Testing Library, no browser in a Session container — so a React component cannot be rendered in a test. Test client behaviour by keeping the decision in a plain module beside the component and letting the component stay a thin caller: `routes/board/composerKeys.ts` holds the Composer's keyboard rules as a pure function over a key description, and `Composer.tsx` only translates the result into state changes. Later examples follow the same shape: `dropPlacement.ts` (drag-and-drop index math), `cardEdits.ts` (edit conflict rule), `lib/commentPost.ts` (comment and upload retry, tested with fake request functions), `components/mentions.ts` (a remark plugin tested on hand-built mdast trees), `lib/errors.ts`, and since 2026-09-24 `boardFilter.ts`, `reviewState.ts`, `sessionStatus.ts`, `previewState.ts`, `lib/files.ts`, the admin `sessionsView.ts`, the admin `boardDeletion.ts`, and the composer's `mentionCandidates.ts` and `mentionText.ts`.

Static markup is the exception: `react-dom/server`'s `renderToStaticMarkup` needs no DOM and can check what a component renders. Importing a `.tsx` file under `node --import tsx` needs `TSX_TSCONFIG_PATH=tsconfig.client.json`. Without it tsx compiles JSX to classic `React.createElement` and the render fails with "React is not defined". The `test` script does not set it, so a committed test that imports a `.tsx` file would need that script changed first. Checked on 2026-09-24 by rendering `components/Markdown.tsx` with a throwaway script.

Client tests live in `packages/app/client/test/*.test.ts` and run under the same `node --import tsx --test` command as the server's, listed in the package's `test` script. They are typechecked by `tsconfig.client-test.json`, which exists only because the client config carries no `node` types and the server test config is rooted at `server/`; `typecheck` runs all four configs. A new client test file is picked up by the existing glob, so only a new *directory* needs script changes.

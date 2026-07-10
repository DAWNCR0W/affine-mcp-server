> Normal pull requests must use a dedicated, non-protected head branch and target `develop`.
> Only `release/*` branches may target `main`. The protected branches `main`, `develop`, `dev`, and `master` may never be used as pull request heads.

## Summary

Describe what changed and why.

## Changes

- 

## Validation

Commands executed:

```bash
npm run build
npm run test:tool-manifest
npm run test:docs
```

If applicable, also include:

```bash
npm run test:comprehensive
```

## Checklist

- [ ] Head branch is a dedicated branch, not `main`, `develop`, `dev`, or `master`
- [ ] Base branch is `develop`, unless this is a `release/*` pull request targeting `main`
- [ ] Tool names remain unique and `snake_case`
- [ ] `tool-manifest.json` updated if tool list changed
- [ ] `README.md` updated if behavior/user-facing API changed
- [ ] Backward compatibility impact described (if any)

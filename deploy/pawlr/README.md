# Vercel front for the Pawlr seller

This folder is a Vercel project with no code: `vercel.json` forwards every
request (an external rewrite, https://vercel.com/docs/routing/rewrites) to the
seller running on the VPS behind Caddy. Rewrite caching is turned off so every
tick reaches the seller.

Deploy (folder name gives the project name "pawlr"):

```bash
npx vercel deploy --prod --yes --cwd deploy/pawlr
```

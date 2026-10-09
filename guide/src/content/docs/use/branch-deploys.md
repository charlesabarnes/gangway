---
title: Branch deploys
description: Keep a branch live at one address, rebuilt in place on every push.
---

A project can deploy one branch, such as `main`, on every push. The first push that serves
becomes the project's production preview, with no expiry. Each later push rebuilds that same
preview in place: the URL, the volumes and the secrets stay. If the new version fails its checks,
the previous one keeps serving.

1. **Connect the repository** under **Repositories**, as for
   [pull-request previews](/docs/use/pull-requests/). A project can do both.

2. **Choose the branch.** In the project's settings, set **Deploy branch** to `main` (or any
   branch). This hands the project's production to that branch's pushes, so it needs the
   `repos.domains` permission.

3. **Commit the workflow** at `.github/workflows/gangway-deploy.yml` on that branch. gangway
   generates it for the project:

   ```sh
   curl -fsS "$GANGWAY_API/v1/projects/<project>/workflow?on=push" \
     -H "Authorization: Bearer $GANGWAY_TOKEN"
   ```

   The push that adds it is the first deploy.

The workflow sends the branch's files as a tarball. gangway builds them as it builds any upload:
a `compose.yaml`, a `Dockerfile`, or a runtime it detects. So a compose stack with named volumes
works, and its data survives every push. gangway trusts the run by the OIDC token GitHub signs
for it, which must be a push to that branch of that repository. There is no secret to store.

Runtime secrets, visibility and template come from the project. Put secrets on its **Secrets**
page.

## The address

A branch deploy is named after the project's slug, under the server's domain, with no random
suffix. Set **Deploy address** to name it something else:

- a bare label, like `docs`, is `docs.<server's domain>`;
- a hostname under the server's domain, like `docs.preview.example.com`, works the same way;
- any other hostname, like `docs.example.com`, is claimed as a custom domain. Add its DNS records
  under [Domains](/docs/use/domains/).

Changing the address renames the live deploy in place. Its containers, volumes and secrets stay;
only the hostnames change. A name that another preview already holds is refused.

## What gangway refuses

- **A pushed image.** Only an uploaded source can be rebuilt in place, so the push workflow
  sends files, not an image.
- **Taking over a production preview someone chose by hand, or one from another branch.** The
  push answers 409. Clear the project's production, and the next push rebuilds it as the branch
  deploy.
- **A project with no deploy branch.** The push answers 409. Choose one in the project's settings.
- **A push from another branch or repository.** The push answers 403: the token says where the
  run came from.

A push of a commit that is already live answers "unchanged" and rebuilds nothing. A broken build
answers 502, and the workflow run fails while the previous version serves.

:::note[Behind GANGWAY_CONTROL_ALLOW]
The deploy call is let through from GitHub's runners with its OIDC token, like a pull-request
workflow's. gangway's own tokens still need a listed network. See
[Security](/docs/reference/security/#keep-the-dashboard-private).
:::

An agent can set this up too: in Claude Code, ask `/gangway:setup-pr-previews` for a branch deploy
of `main`. The MCP `project` tool takes the branch and answers with the workflow.

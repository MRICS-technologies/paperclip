# MRICS Paperclip production fork

This fork keeps MRICS production changes separate from upstream Paperclip while preserving a repeatable upgrade path.

## Branches and remotes

- `upstream`: `https://github.com/paperclipai/paperclip.git`
- `origin`: `https://github.com/MRICS-technologies/paperclip.git`
- `mrics/prod`: the source of the deployed MRICS image

Do not develop production changes directly on upstream's `master` branch.

## Image contract

Every push to `mrics/prod` builds an amd64 production image and publishes:

- `ghcr.io/mrics-technologies/paperclip:prod`
- `ghcr.io/mrics-technologies/paperclip:mrics-sha-<short-sha>`
- an immutable digest reported by the workflow

Production must deploy the immutable digest, not the mutable `prod` tag. The mutable tag is only a convenient pointer to the newest successful build.

The MRICS GHCR package is intentionally private. Every deployment server must authenticate to `ghcr.io` as its Coolify server user with a dedicated token that can read packages. Docker stores the credential in that user's `~/.docker/config.json`; rotate the token and repeat `docker login` before it expires or is revoked.

## Updating from an upstream release

1. Fetch upstream and tags:

   ```bash
   git fetch upstream --tags
   ```

2. Start an update branch from the current production branch:

   ```bash
   git switch mrics/prod
   git switch -c sync/upstream-<version>
   ```

3. Merge the upstream stable release tag. Do not rebase the published production branch:

   ```bash
   git merge --no-ff <stable-release-tag>
   ```

4. Resolve conflicts while preserving MRICS changes, then run the relevant tests, type-checks, and image build checks.

5. Merge the reviewed update branch into `mrics/prod` and push. Wait for the image workflow to finish.

6. Deploy the workflow's immutable image digest through Coolify. Keep the previous digest recorded for rollback.

7. Verify health, database migrations, login, and the Hermes queued-message interrupt flow before declaring the update complete.

## Current MRICS customization

The initial production branch adds cancellation propagation to the Hermes Gateway adapter. Paperclip cancellation now requests Hermes `/stop`, confirms provider termination, and only then permits queued continuation work to proceed.

# CoLearnX Training Platform

CoLearnX is a course and learning-resource marketplace. Trainers publish courses, creators share downloadable materials, and learners use points to purchase access. The React/Vite frontend, Express API, PostgreSQL migrations and video services live in `colearnx-v1.0/`.

## Run locally

Use Node.js **22.23.4** (the version pinned in the repository), npm and Docker with Compose v2. Start in the repository root. The commands below use PowerShell. On macOS or Linux, use `npm` for `npm.cmd` and `cp` for `Copy-Item`.

### 1. Install dependencies and configure the API

On the first run, install both sets of dependencies and copy the environment templates.

```powershell
cd colearnx-v1.0
npm.cmd ci
npm.cmd --prefix apps/api ci
Copy-Item .env.compose.example .env
Copy-Item apps/api/.env.example apps/api/.env
```

In `.env`, set the four database passwords. In `apps/api/.env`, set the password in `DATABASE_URL` to the value of `COLEARNX_APP_PASSWORD` and the password in `MIGRATION_DATABASE_URL` to the value of `POSTGRES_ADMIN_PASSWORD`. Keep the example usernames and local database port **5433**. Generate a different value for each password, `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `CSRF_SECRET` and `EMAIL_VERIFICATION_CODE_PEPPER` with this command.

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

### 2. Start the database and API

```powershell
docker compose up -d --wait postgres redis
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd --prefix apps/api run dev
```

Leave the API running. Its readiness endpoint should return `ready`. The seed creates reference data such as roles and point packages. New password accounts need email verification, so configure Resend to test registration and sign-in with a new email address. [API readiness](http://localhost:3001/health/ready) · [Email setup](colearnx-v1.0/docs/EMAIL_VERIFICATION.md)

### 3. Start the frontend

In a second terminal, from the repository root, run the following commands.

```powershell
cd colearnx-v1.0
npm.cmd run dev
```

Open the local site. Vite forwards `/api` requests to port **3001**. Editing a name in **Profile → Edit profile → Save changes** writes it to PostgreSQL. Opening a new tab or signing in again loads that account’s saved details from the API. [Local site](http://localhost:5173) · [Local setup and optional services](colearnx-v1.0/docs/LOCAL_RUNBOOK.md)

## Video uploads

| Where you upload | Maximum size per file | Maximum video length |
| --- | --- | --- |
| Main video in an online course | **100 MiB** in the team's documented staging configuration. The API default is **20 GiB** when hosted video is enabled. | **4 hours** per video, verified after upload by the FFmpeg worker. Both limits apply. |
| Downloadable MP4 attached to a resource or course | **100 MiB** by default. Other supported attachment types default to **25 MiB**. | Attachments are checked by file size and type. They have no separate running-time limit. |

**Why a demo video can fill the allowance in about a minute.** At a total bitrate of 14 Mbit/s, 100 MiB holds about **1 minute** of video. At 2 Mbit/s, the same space holds about **7 minutes**. A lower export bitrate can fit a longer clip under the same cap. The team uses a smaller staging limit to manage free-tier usage. R2 meters storage and operations, and the playback gateway uses the Workers request allowance. The running API’s environment determines the deployed file-size cap. [Staging configuration record](colearnx-v1.0/docs/LOCAL_VIDEO_BATCH_WORKER.md) · [R2 free tier](https://developers.cloudflare.com/r2/pricing/#free-tier) · [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

### Change a limit

- **Main video size.** Set `VIDEO_SOURCE_MAX_BYTES` in `colearnx-v1.0/apps/api/.env` locally or in the Render API service’s **Environment** settings. For example, `104857600` gives 100 MiB and `268435456` gives 256 MiB. Restart the local API or deploy the updated Render environment. [API environment example](colearnx-v1.0/apps/api/.env.example)
- **Downloadable files.** In the same API environment, `CONTENT_VIDEO_UPLOAD_MAX_BYTES` controls MP4 attachments (25–100 MiB) and `CONTENT_UPLOAD_MAX_BYTES` controls other attachments. `CONTENT_STORAGE_QUOTA_BYTES` defaults to 500 MiB per account and `CONTENT_PENDING_UPLOAD_LIMIT` to three pending uploads. Align the frontend file checks and upload hints with any new limits, then rebuild the frontend. [API settings](colearnx-v1.0/apps/api/src/config/env.ts) · [Frontend file checks](colearnx-v1.0/src/utils/uploadPolicy.js)
- **Main video length.** The four-hour limit is enforced in code and the database. Changing it requires a worker, API, database and frontend update. Hosted playback also needs private R2 storage, a running transcoding worker and the media gateway. The setup guide lists the relevant files and feature switches. [Hosted-video configuration](colearnx-v1.0/docs/HOSTED_VIDEO_DEPLOYMENT.md)

For test commands, API routes and staging releases, see the [application README](colearnx-v1.0/README.md), [API reference](colearnx-v1.0/docs/API.md) and [staging release guide](colearnx-v1.0/docs/STAGING_CICD.md).

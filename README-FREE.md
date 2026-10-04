# Rise Upon Deen V2 — 100% No-Paid-Service Notification Setup

This version removes Firebase Cloud Functions from the notification path. Firebase Cloud Messaging remains free, Firestore remains on the Firebase Spark no-cost plan, AlAdhan is used for prayer-time calculation, and the trusted scheduler runs with GitHub Actions.

## What is free

- Firebase Cloud Messaging (FCM): free Firebase product.
- Firebase Authentication: no-cost options remain available.
- Firebase Firestore: Spark plan includes no-cost quota; if the quota is exceeded, Firebase does not bill Spark usage.
- Firebase Hosting: use within its Spark quota.
- AlAdhan Prayer Times API: public API used by the app.
- GitHub Actions: standard GitHub-hosted runners are free for public repositories.
- No Firebase Cloud Functions.
- No Cloud Run.
- No Cloud Scheduler.
- No paid notification provider.
- No service-account key in the HTML or service worker.

## Closed-app prayer notifications

GitHub Actions runs the trusted sender every 5 minutes. It reads active FCM subscriptions from Firestore, refreshes today's AlAdhan prayer times when needed, and sends FCM notifications. The service worker receives and displays them even when the PWA/site is closed, subject to browser/OS push rules.

Because GitHub's minimum scheduled-workflow interval is 5 minutes, this free architecture is not second-perfect. A 10-minute catch-up window prevents normal scheduler delay from losing an alert, but delivery can be a few minutes after the exact prayer time. This is the strongest practical design here without paying for a server scheduler.

## One-time GitHub setup

1. Create a **public** GitHub repository for this package. Public repositories get free standard GitHub-hosted Actions runners.
2. Upload the package contents to the repository's default branch.
3. In Firebase Console, open Project settings → Service accounts → Generate new private key.
4. In GitHub: Settings → Secrets and variables → Actions → New repository secret.
5. Name it exactly:

   `FIREBASE_SERVICE_ACCOUNT_JSON`

6. Paste the entire downloaded Firebase service-account JSON into the secret value.
7. Open Actions and run **Rise Upon Deen Free Push Scheduler** once manually.
8. Enable Actions if GitHub asks.

Never commit the service-account JSON into the repository.

## Admin notifications

The Admin → Send Notification screen no longer needs a paid/hosted sender URL. It writes a protected `push_jobs` document to Firestore. The free GitHub scheduler processes that job on its next run. Immediate notifications therefore normally arrive within about 0–5 minutes.

Scheduled notifications are stored in the same queue and processed when their scheduled time has arrived.

## Important limits

- GitHub scheduled workflows have a minimum 5-minute interval.
- GitHub may delay scheduled workflow starts under heavy load.
- Scheduled workflows are based on the default branch.
- Keep the repository public to keep standard GitHub-hosted Actions free and unlimited.
- Do not put the Firebase service-account JSON in HTML, JavaScript, `sw.js`, or any public file.
- Web push still requires HTTPS and notification permission. On iPhone/iPad, the PWA must be installed to the Home Screen for web push.

## Firebase deployment

Deploy only Hosting and Firestore from this package:

```bash
firebase deploy --only hosting,firestore:rules,firestore:indexes
```

Do **not** deploy Firebase Functions from this free package.

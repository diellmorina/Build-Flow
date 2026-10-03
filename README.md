# BuildFlow

A no-build HTML, CSS, and JavaScript website-builder workspace with Firebase Authentication, Cloud Firestore, Firebase Storage, Cloud Functions, and Firebase Hosting integration.

## Current capabilities

- Create and edit structured website drafts, with local browser storage when Firebase is not configured.
- Firebase email/password signup, verified email login, logout, password reset, and profile storage.
- Owner-scoped Firestore project persistence and Firebase Storage image uploads.
- Private administrator directory with account creation dates and last-active activity.
- Server-side structured AI generation through a callable Cloud Function.
- Sandboxed website preview, starter templates, bounded history, and local workspace export.

Starter drafts are deterministic and are not presented as AI output. Publishing a generated website, billing, and analytics are not implemented.

## Firebase setup

1. Create a Firebase project. Register a Web app in **Project settings → General → Your apps** and copy its web configuration into `config.js`. These web config values identify the project; never put Admin SDK service-account credentials or AI keys in browser files.
2. Under **Authentication → Sign-in method**, enable **Email/Password**. Under **Authentication → Settings → Authorized domains**, add `localhost` and your Firebase Hosting domain.
3. Create a **Cloud Firestore** database and enable **Storage** in the Firebase console.
4. Install or run the Firebase CLI, sign in, and select your Firebase project from this workspace:

	```powershell
	npx firebase-tools login
	npx firebase-tools use --add
	```

5. Deploy the Firestore and Storage security rules and Firebase Hosting:

	```powershell
	npx firebase-tools deploy --only firestore:rules,storage,hosting
	```

6. To use cloud projects, activity tracking, and the admin directory, install the Cloud Function dependencies and deploy the non-AI functions:

	```powershell
	npm install --prefix functions
	npx firebase-tools deploy --only functions:touchLastActive,functions:adminUsers
	```

	Cloud Functions deployment requires the Firebase project to be on the Blaze billing plan. The app continues to support local drafts without deploying functions.

7. Add the Firebase Hosting origin to Authorized domains if it is not already listed, then open the Hosting URL and sign up. BuildFlow sends an email verification link; verify the address before logging in.

## Administrator access

Admin functions require both a Firebase Auth custom claim (`admin: true`) and an admin profile document. The browser cannot grant either permission. To promote a user, install the function dependencies, authenticate the Firebase Admin SDK with Application Default Credentials, and run the trusted provisioning script:

```powershell
gcloud auth application-default login
$env:GOOGLE_CLOUD_PROJECT = "your-firebase-project-id"
node .\functions\set-admin.js FIREBASE_AUTH_USER_UID
```

Ask that user to sign out and back in to refresh the custom claim. To revoke admin access, pass `false` as the last argument. Never commit service-account JSON files.

## AI generation

Set the OpenAI key as a Firebase Functions secret, then deploy the AI callable function:

```powershell
npx firebase-tools functions:secrets:set OPENAI_API_KEY
npx firebase-tools deploy --only functions:generateSite
```

Optionally set `OPENAI_MODEL` as a function environment variable. The callable verifies Firebase Authentication, validates prompt length, requests a strict website schema, and records usage in Firestore. The OpenAI key stays server-side.

## Data and migration

Firebase rules restrict projects and assets to their authenticated owner. Profile roles cannot be changed by clients. Last-active time is updated through an authenticated Cloud Function. Existing Supabase accounts, projects, and stored data are **not** migrated or deleted from the old Supabase project; export anything you need before moving it. The old Supabase credentials and integration files have been removed from this workspace.

## Limitations

- Local browser drafts are kept separate from Firebase account data; there is no automatic local-to-cloud import.
- Versions are stored with each project document; advanced multi-page editing, collaboration, and a code editor are future work.
- Publishing generated sites, billing, analytics, and notifications need separate integrations.
- The admin directory currently loads profile documents for its overview and is intended for an early-stage project, not a very large user base.

## Checks

No frontend build step is required. Validate the browser module with `Get-Content -Raw .\app.js | node --input-type=module --check`, and validate server functions with `node --check .\functions\index.js`.
const { applicationDefault, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
const uid = process.argv[2];
const shouldGrant = process.argv[3] !== "false";

if (!projectId || !uid) {
  console.error("Usage: GOOGLE_CLOUD_PROJECT=your-project-id node set-admin.js USER_UID [false]");
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId });

async function setAdminRole() {
  const auth = getAuth();
  const user = await auth.getUser(uid);
  const customClaims = { ...user.customClaims };
  if (shouldGrant) customClaims.admin = true;
  else delete customClaims.admin;
  await auth.setCustomUserClaims(uid, customClaims);
  await getFirestore().collection("profiles").doc(uid).set({ role: shouldGrant ? "admin" : "user" }, { merge: true });
  console.log(`Admin role ${shouldGrant ? "granted to" : "removed from"} ${user.email || uid}. Ask the user to sign out and sign back in.`);
}

setAdminRole().catch((error) => {
  console.error("Could not update administrator role:", error.message);
  process.exitCode = 1;
});
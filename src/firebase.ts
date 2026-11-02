import { getApp, getApps, initializeApp, type FirebaseApp } from "@firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  setPersistence,
  type Auth
} from "@firebase/auth";
import { getFirestore, type Firestore } from "@firebase/firestore";
import { getFunctions, type Functions } from "@firebase/functions";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

const hasFirebaseConfiguration = Boolean(
  firebaseConfig.apiKey &&
    firebaseConfig.authDomain &&
    firebaseConfig.projectId &&
    firebaseConfig.appId
);

let app: FirebaseApp | undefined;
let auth: Auth | undefined;
let db: Firestore | undefined;
let functions: Functions | undefined;
let googleProvider: GoogleAuthProvider | undefined;

if (hasFirebaseConfiguration) {
  app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  auth = getAuth(app);
  // Customer accounts remain available on the device until the customer signs
  // out. Firestore Rules, not browser persistence, protect private records.
  void setPersistence(auth, browserLocalPersistence);
  db = getFirestore(app);
  functions = getFunctions(app, "us-west2");
  googleProvider = new GoogleAuthProvider();
  googleProvider.setCustomParameters({ prompt: "select_account" });
}

export { auth, db, functions, googleProvider };
export const firebaseEnabled = hasFirebaseConfiguration;

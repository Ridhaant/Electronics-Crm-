// Soneja Electronics - Firebase Configuration & Storage

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  databaseURL?: string;
}

const STORAGE_KEY = "soneja_firebase_config";

// Default configuration based on project "soneja-electronics"
export const DEFAULT_FIREBASE_CONFIG: FirebaseConfig = {
  apiKey: "AIzaSyBiNRxksfYYTmp8RZwXuTeVjo6OHw-Lkhc",
  authDomain: "soneja-electronics.firebaseapp.com",
  databaseURL: "https://soneja-electronics-default-rtdb.firebaseio.com",
  projectId: "soneja-electronics",
  storageBucket: "soneja-electronics.firebasestorage.app",
  messagingSenderId: "533974413111",
  appId: "1:533974413111:web:f7180e1702a6fc8d0b74b2",
};

export function getActiveFirebaseConfig(): FirebaseConfig | null {
  // 1. Check browser saved config
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.apiKey && parsed.projectId) {
        return parsed;
      }
    }
  } catch (e) {
    console.warn("Failed to parse saved Firebase config:", e);
  }

  // 2. Check defaults / env variables
  if (DEFAULT_FIREBASE_CONFIG.apiKey && DEFAULT_FIREBASE_CONFIG.projectId) {
    return DEFAULT_FIREBASE_CONFIG;
  }

  return null;
}

export function saveFirebaseConfig(config: FirebaseConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function clearFirebaseConfig() {
  localStorage.removeItem(STORAGE_KEY);
}

import type { CloudUser } from "../../../shared/cloud-user";

/**
 * Freestyle has no accounts: every window runs as this one local user, so the
 * UI treats the app as permanently signed in. Cloud-only surfaces (Remix,
 * billing, profile) are hidden rather than gated on this value.
 *
 * The shape is the old sign-in context, with the sign-in members inert, so
 * code that still reads `useCloudAuth()` needs no edits.
 */
const LOCAL_USER: CloudUser = { id: "local", email: "" };

export interface UseCloudAuth {
  user: CloudUser | null;
  phase: "checking" | "authenticated" | "signed_out";
  canRequestData: boolean;
  loading: boolean;
  signingIn: boolean;
  userCode: string | null;
  error: string | null;
  sessionExpired: boolean;
  refresh: () => Promise<CloudUser | null>;
  signIn: () => Promise<CloudUser | null>;
  cancelSignIn: () => void;
  signOut: () => Promise<void>;
}

const LOCAL_AUTH: UseCloudAuth = {
  user: LOCAL_USER,
  phase: "authenticated",
  canRequestData: true,
  loading: false,
  signingIn: false,
  userCode: null,
  error: null,
  sessionExpired: false,
  refresh: async () => LOCAL_USER,
  signIn: async () => LOCAL_USER,
  cancelSignIn: () => {},
  signOut: async () => {},
};

export function useCloudAuth(): UseCloudAuth {
  return LOCAL_AUTH;
}

import { ClerkProvider, SignIn, useAuth as useClerkAuth, useClerk, useUser } from "@clerk/react";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { keys, request } from "./api";
import { ClerkBridge, clerkPublishableKey, scriptNonce } from "./auth";
import { setTokenProvider } from "./api";

function Bridge({ children }: { children: ReactNode }) {
  const { getToken, signOut, isLoaded, isSignedIn } = useClerkAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const get = useCallback(() => getToken(), [getToken]);
  const openProfile = useCallback(() => clerk.openUserProfile(), [clerk]);
  const out = useCallback(async () => {
    await signOut();
  }, [signOut]);
  useEffect(() => {
    setTokenProvider(get);
  }, [get]);
  // When the Clerk profile changes (avatar, name), have the server re-sync and refresh what the page shows.
  const qc = useQueryClient();
  const seen = useRef<string | null>(null);
  const fingerprint = user ? `${user.imageUrl}|${user.fullName ?? ""}` : null;
  useEffect(() => {
    if (!fingerprint) return;
    if (seen.current === null) {
      seen.current = fingerprint;
      return;
    }
    if (seen.current === fingerprint) return;
    seen.current = fingerprint;
    void request("/me/refresh", { method: "POST" }).then(() => {
      void qc.invalidateQueries({ queryKey: keys.me });
      void qc.invalidateQueries({ queryKey: ["board"] });
    });
  }, [fingerprint, qc]);
  if (!isLoaded) return null;
  if (!isSignedIn || !user) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg p-6">
        <SignIn routing="hash" />
      </div>
    );
  }
  return (
    <ClerkBridge getToken={get} signOut={out} openProfile={openProfile}>
      {children}
    </ClerkBridge>
  );
}

export default function ClerkAuthProvider({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider
      publishableKey={clerkPublishableKey!}
      nonce={scriptNonce}
      appearance={{
        variables: {
          colorBackground: "#191816",
          colorForeground: "#ece7de",
          colorMutedForeground: "#a69f93",
          colorPrimary: "#d9a05b",
          colorPrimaryForeground: "#1b1710",
          colorInput: "#121110",
          colorInputForeground: "#ece7de",
          colorBorder: "#3b3833",
          borderRadius: "10px",
          fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif",
        },
      }}
    >
      <Bridge>{children}</Bridge>
    </ClerkProvider>
  );
}

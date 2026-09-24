import { StrictMode, lazy, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { DevAuthProvider, clerkPublishableKey } from "./lib/auth";
import { guardStrayFileDrops } from "./lib/fileInput";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 10_000 } },
});

const ClerkAuthProvider = lazy(() => import("./lib/clerk-provider"));

function AuthRoot({ children }: { children: ReactNode }) {
  if (clerkPublishableKey) {
    return (
      <Suspense fallback={null}>
        <ClerkAuthProvider>{children}</ClerkAuthProvider>
      </Suspense>
    );
  }
  return <DevAuthProvider>{children}</DevAuthProvider>;
}

guardStrayFileDrops();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthRoot>
          <App />
        </AuthRoot>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

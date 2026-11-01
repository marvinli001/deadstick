import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { ToastStack, ToastStackProvider } from '@/components/arc/toast-stack/toast-stack';
import { ApiError } from '@/lib/api';
import { SessionProvider } from '@/lib/session';
import { router } from './router';
import './styles/global.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failures, error) =>
        !(error instanceof ApiError && error.status < 500) && failures < 2,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastStackProvider>
        <SessionProvider>
          <RouterProvider router={router} />
        </SessionProvider>
        <ToastStack label="通知" position="bottom-center" hotkey={false} />
      </ToastStackProvider>
    </QueryClientProvider>
  </StrictMode>,
);

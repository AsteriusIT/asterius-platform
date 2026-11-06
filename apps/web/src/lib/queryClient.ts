import { MutationCache, QueryClient, useMutation, type UseMutationOptions } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { ApiError, errorText } from './api';

/** Red toast for a failed operation. */
export function notifyError(error: unknown, title = 'Something went wrong') {
  notifications.show({ color: 'red', title, message: errorText(error) });
}

/**
 * The portal's QueryClient. Any mutation without its own `onError` shows an error toast, so a failed
 * request is never silent.
 */
export function createQueryClient() {
  return new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _vars, _ctx, mutation) => {
        if (!mutation.options.onError) notifyError(error);
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        refetchOnWindowFocus: true,
        retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
      },
    },
  });
}

/** `useMutation` that shows an error toast on failure (in addition to any `onError` given). */
export function useAppMutation<TData = unknown, TVars = void>(options: UseMutationOptions<TData, Error, TVars>) {
  return useMutation<TData, Error, TVars>({
    ...options,
    onError: (error, vars, ctx, mutationCtx) => {
      notifyError(error);
      return options.onError?.(error, vars, ctx, mutationCtx);
    },
  });
}

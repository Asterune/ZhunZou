import { ref } from 'vue';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

const toasts = ref<Toast[]>([]);
let sequence = 0;

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
}

export function pushToast(message: string, kind: ToastKind = 'info'): void {
  const id = (sequence += 1);
  toasts.value = [...toasts.value, { id, message, kind }];
  setTimeout(() => dismissToast(id), 4_000);
}

export function useToasts(): {
  toasts: typeof toasts;
  dismissToast: typeof dismissToast;
} {
  return { toasts, dismissToast };
}

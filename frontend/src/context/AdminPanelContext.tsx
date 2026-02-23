import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

type AdminPanelContextValue = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
};

const AdminPanelContext = createContext<AdminPanelContextValue | null>(null);

export function AdminPanelProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const value = useMemo(() => ({ isOpen, open, close }), [isOpen, open, close]);
  return (
    <AdminPanelContext.Provider value={value}>{children}</AdminPanelContext.Provider>
  );
}

export function useAdminPanel(): AdminPanelContextValue {
  const ctx = useContext(AdminPanelContext);
  if (!ctx) throw new Error('useAdminPanel must be used within AdminPanelProvider');
  return ctx;
}

import { useCallback, useEffect, useState } from "react";
import { getUsers, type UserListItem } from "../../api/usersApi";

export interface UsersAdminData {
  users: UserListItem[];
  isLoading: boolean;
  error: string;
  setError: (nextError: string) => void;
  loadUsers: () => Promise<void>;
  /** Optimistic removal of one user (returns the prior list for rollback). */
  removeUserLocal: (userId: string) => UserListItem[];
  /** Optimistic in-place edit of one user (returns prior list for rollback). */
  patchUserLocal: (userId: string, patch: Partial<UserListItem>) => UserListItem[];
  restoreUsers: (prev: UserListItem[]) => void;
}

export function useUsersAdminData(token: string | null): UsersAdminData {
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  const loadUsers = useCallback(async () => {
    if (!token) {
      setUsers([]);
      setIsLoading(false);
      setError("");
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      setUsers(await getUsers(token));
    } catch (fetchError) {
      setError(
        fetchError instanceof Error
          ? fetchError.message
          : "Failed to load users",
      );
    } finally {
      setIsLoading(false);
    }
  }, [token]);

  const removeUserLocal = useCallback((userId: string): UserListItem[] => {
    let prev: UserListItem[] = [];
    setUsers((rows) => {
      prev = rows;
      return rows.filter((u) => u.id !== userId);
    });
    return prev;
  }, []);

  const patchUserLocal = useCallback(
    (userId: string, patch: Partial<UserListItem>): UserListItem[] => {
      let prev: UserListItem[] = [];
      setUsers((rows) => {
        prev = rows;
        return rows.map((u) => (u.id === userId ? { ...u, ...patch } : u));
      });
      return prev;
    },
    [],
  );

  const restoreUsers = useCallback((prev: UserListItem[]) => {
    setUsers(prev);
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  return {
    users,
    isLoading,
    error,
    setError,
    loadUsers,
    removeUserLocal,
    patchUserLocal,
    restoreUsers,
  };
}

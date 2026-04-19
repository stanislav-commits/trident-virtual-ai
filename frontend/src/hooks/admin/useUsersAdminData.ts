import { useCallback, useEffect, useState } from "react";
import { getUsers, type UserListItem } from "../../api/usersApi";

export interface UsersAdminData {
  users: UserListItem[];
  isLoading: boolean;
  error: string;
  setError: (nextError: string) => void;
  loadUsers: () => Promise<void>;
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

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  return {
    users,
    isLoading,
    error,
    setError,
    loadUsers,
  };
}

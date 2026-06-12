import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getShips, type ShipSummaryItem } from "../api/shipsApi";
import { useAuth } from "./AuthContext";

const STORAGE_KEY = "trident_admin_active_ship";

type AdminShipOption = Pick<
  ShipSummaryItem,
  "id" | "name" | "organizationName" | "imoNumber" | "buildYear"
>;

type AdminShipContextValue = {
  availableShips: AdminShipOption[];
  selectedShipId: string | null;
  selectedShip: AdminShipOption | null;
  sessionShipId: string | undefined;
  isLoading: boolean;
  error: string | null;
  setSelectedShipId: (shipId: string | null) => void;
  refreshShips: () => Promise<void>;
};

const AdminShipContext = createContext<AdminShipContextValue | null>(null);

function loadStoredShipId(): string | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value?.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function AdminShipProvider({ children }: { children: ReactNode }) {
  const { user, token, isAuthenticated } = useAuth();
  const isAdmin = user?.role === "admin";

  const [availableShips, setAvailableShips] = useState<AdminShipOption[]>([]);
  const [selectedShipId, setSelectedShipIdState] = useState<string | null>(
    loadStoredShipId,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const persistSelection = useCallback((shipId: string | null) => {
    try {
      if (shipId) {
        localStorage.setItem(STORAGE_KEY, shipId);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // localStorage might be unavailable; keep state in memory
    }
  }, []);

  const setSelectedShipId = useCallback(
    (shipId: string | null) => {
      setSelectedShipIdState(shipId);
      if (isAdmin) {
        persistSelection(shipId);
      }
    },
    [isAdmin, persistSelection],
  );

  const refreshShips = useCallback(async () => {
    if (!isAuthenticated || !token) {
      setAvailableShips([]);
      setSelectedShipIdState(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const ships = await getShips(token);
      const options = ships.map((ship) => ({
        id: ship.id,
        name: ship.name,
        organizationName: ship.organizationName,
        imoNumber: ship.imoNumber,
        buildYear: ship.buildYear,
      }));

      setAvailableShips(options);
      setSelectedShipIdState((current) => {
        if (!isAdmin) {
          const userShipId = user?.shipId ?? null;
          return userShipId && options.some((ship) => ship.id === userShipId)
            ? userShipId
            : options.length === 1
              ? options[0].id
              : null;
        }

        const isStillValid =
          current != null && options.some((ship) => ship.id === current);
        const nextShipId =
          isStillValid
            ? current
            : options.length === 1
              ? options[0].id
              : null;
        persistSelection(nextShipId);
        return nextShipId;
      });
    } catch (fetchError) {
      setAvailableShips([]);
      setSelectedShipIdState(null);
      setError(
        fetchError instanceof Error
          ? fetchError.message
          : "Failed to load ships",
      );
    } finally {
      setIsLoading(false);
    }
  }, [isAdmin, isAuthenticated, persistSelection, token, user?.shipId]);

  useEffect(() => {
    void refreshShips();
  }, [refreshShips]);

  const selectedShip = useMemo(
    () =>
      selectedShipId
        ? availableShips.find((ship) => ship.id === selectedShipId) ?? null
        : null,
    [availableShips, selectedShipId],
  );

  const value = useMemo<AdminShipContextValue>(
    () => ({
      availableShips,
      selectedShipId,
      selectedShip,
      sessionShipId: isAdmin ? selectedShipId ?? undefined : user?.shipId ?? undefined,
      isLoading,
      error,
      setSelectedShipId,
      refreshShips,
    }),
    [
      availableShips,
      error,
      isAdmin,
      isLoading,
      refreshShips,
      selectedShip,
      selectedShipId,
      setSelectedShipId,
      user?.shipId,
    ],
  );

  return (
    <AdminShipContext.Provider value={value}>
      {children}
    </AdminShipContext.Provider>
  );
}

export function useAdminShip(): AdminShipContextValue {
  const ctx = useContext(AdminShipContext);
  if (!ctx) {
    throw new Error("useAdminShip must be used within AdminShipProvider");
  }

  return ctx;
}

import { useCallback, useEffect, useState } from "react";
import {
  getOrganizations,
  getShips,
  type ShipSummaryItem,
} from "../../api/shipsApi";

export interface ShipsAdminData {
  ships: ShipSummaryItem[];
  organizations: string[];
  shipsLoading: boolean;
  organizationsLoading: boolean;
  error: string;
  setError: (nextError: string) => void;
  loadShips: () => Promise<void>;
}

export function useShipsAdminData(
  token: string | null,
  enabled: boolean,
): ShipsAdminData {
  const [ships, setShips] = useState<ShipSummaryItem[]>([]);
  const [organizations, setOrganizations] = useState<string[]>([]);
  const [shipsLoading, setShipsLoading] = useState(false);
  const [organizationsLoading, setOrganizationsLoading] = useState(false);
  const [error, setError] = useState("");

  const loadShips = useCallback(async () => {
    if (!token) {
      setShips([]);
      setOrganizations([]);
      setShipsLoading(false);
      setOrganizationsLoading(false);
      setError("");
      return;
    }

    setShipsLoading(true);
    setOrganizationsLoading(true);
    setError("");

    try {
      const [shipsResult, organizationsResult] = await Promise.allSettled([
        getShips(token),
        getOrganizations(token),
      ]);

      if (shipsResult.status !== "fulfilled") {
        throw new Error("Failed to load ships");
      }

      setShips(shipsResult.value);

      if (organizationsResult.status === "fulfilled") {
        setOrganizations(organizationsResult.value);
        return;
      }

      setOrganizations([]);
      setError(
        organizationsResult.reason instanceof Error
          ? organizationsResult.reason.message
          : "Failed to load organizations",
      );
    } catch (fetchError) {
      setError(
        fetchError instanceof Error
          ? fetchError.message
          : "Failed to load ships",
      );
    } finally {
      setShipsLoading(false);
      setOrganizationsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    void loadShips();
  }, [enabled, loadShips]);

  return {
    ships,
    organizations,
    shipsLoading,
    organizationsLoading,
    error,
    setError,
    loadShips,
  };
}

import { createContext, useContext } from "react";
import { ApiError, type BolverseApi } from "@bolverse/shared";

export const ApiContext = createContext<BolverseApi | null>(null);

export function useApi(): BolverseApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("ApiContext missing");
  return api;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong. Try again.";
}

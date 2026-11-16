import { createContext, useContext } from "react";
import type { Person } from "./types";

/** Who this device is logged in as; anything in the app can ask what they may do. */
export const MeContext = createContext<Person | null>(null);
export const useMe = () => useContext(MeContext);

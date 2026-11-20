"use client";

import { useState, useEffect } from "react";

export type Profile = "All" | "Work" | "Client" | "Personal";

const STORAGE_KEY = "daedalus:profile";

export function useProfile(): [Profile, (p: Profile) => void] {
  const [profile, setProfile] = useState<Profile>("All");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as Profile | null;
      if (stored && ["All", "Work", "Client", "Personal"].includes(stored)) {
        setProfile(stored);
      }
    } catch {
      // ignore
    }

    const handler = (e: Event) => {
      const custom = e as CustomEvent<Profile>;
      if (custom.detail && ["All", "Work", "Client", "Personal"].includes(custom.detail)) {
        setProfile(custom.detail);
      }
    };

    window.addEventListener("daedalus:profile-change", handler);
    return () => {
      window.removeEventListener("daedalus:profile-change", handler);
    };
  }, []);

  const selectProfile = (p: Profile) => {
    setProfile(p);
    try {
      localStorage.setItem(STORAGE_KEY, p);
      window.dispatchEvent(new CustomEvent("daedalus:profile-change", { detail: p }));
    } catch {
      // ignore
    }
  };

  return [profile, selectProfile];
}

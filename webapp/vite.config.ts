import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Sin alias ni configuración extra: el bundle es chico y no hay build previo.
export default defineConfig({
  plugins: [react()],
});

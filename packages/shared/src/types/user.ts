// Cross-app user types (single source of truth for web + api).

export type Role = "admin" | "member" | "viewer";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
}

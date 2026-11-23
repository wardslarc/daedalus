// Fake secrets, built from parts so no real-looking token sits in the source as one string.
const j = (...p: string[]) => p.join("");
export const PLANTED = {
  anthropic: j("sk-ant-", "api03-", "Zx9QpL2mN8vR4tY6wB1cD3eF5gH7jK0aS2dF4gH6jK8lQ"),
  openai: j("sk-", "proj-", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"),
  github: j("ghp_", "16C7e42F292c6912E7710c838347Ae178B4a"),
  githubPat: j("github_pat_", "11ABCDEFG0abcdefghijkl_mnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX"),
  gitlab: j("glpat-", "xY7zW3vU1tS9rQ5pO2nM"),
  slack: j("xoxb-", "1234567890-0987654321-AbCdEfGhIjKlMnOpQrStUvWx"),
  aws: j("AKIA", "IOSFODNN7EXAMPLE"),
  google: j("AIza", "SyD3x4mpl3K3yV4lu3F0rT3st1ngPurp0s3s"),
  npm: j("npm_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"),
  jwt: j("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
  urlPass: "hunter2-Very-Secret",
  assigned: "s3cr3t-Assigned-Value",
  entropy: j("Q7f2Lm9Xa4", "Rt8Vb1Zk6Np3", "Wy5Hc0Gd2Js7"),
};

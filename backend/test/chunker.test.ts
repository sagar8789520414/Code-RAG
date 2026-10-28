import { describe, expect, it } from "vitest";
import { chunkAst } from "../src/ingestion/astChunker.js";
import { AST_LANGUAGES, strategyForPath } from "../src/ingestion/languages.js";
import { chunkFixed, chunkMarkdown } from "../src/ingestion/textChunker.js";

const ts = AST_LANGUAGES.typescript!;
const py = AST_LANGUAGES.python!;

const TS_SOURCE = `import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";

/**
 * Verifies the bearer token and attaches the session.
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers.authorization?.slice(7);
  if (!token) return void res.status(401).end();
  req.session = await validateSessionToken(token);
  next();
}

export const validateSessionToken = async (token: string): Promise<Session> => {
  return jwt.verify(token, process.env.SECRET!) as Session;
};

export class SessionStore {
  private sessions = new Map<string, Session>();
  get(id: string) { return this.sessions.get(id); }
  set(id: string, s: Session) { this.sessions.set(id, s); }
}

const router = express.Router();
router.use(authMiddleware);
router.get("/me", (req, res) => res.json(req.session));
router.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime(), version: process.env.APP_VERSION }));
export default router;
`;

describe("AST chunker (TypeScript)", () => {
  it("extracts functions, arrow functions and classes with metadata", async () => {
    const chunks = await chunkAst(ts, TS_SOURCE, "src/auth/middleware.ts", { maxChars: 3500 });
    const byName = Object.fromEntries(chunks.map((c) => [c.name, c]));

    const mw = byName.authMiddleware!;
    expect(mw.kind).toBe("function");
    expect(mw.startLine).toBe(4); // includes the JSDoc block
    expect(mw.endLine).toBe(12);
    expect(mw.docstring).toContain("Verifies the bearer token");
    expect(mw.signature).toBe("export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void>");

    const arrow = byName.validateSessionToken!;
    expect(arrow.kind).toBe("function");
    expect(arrow.signature).toContain("export const validateSessionToken = async (token: string): Promise<Session> =>");

    expect(byName.SessionStore!.kind).toBe("class");
    expect(byName.SessionStore!.content).toContain("set(id: string");

    const file = chunks.find((c) => c.kind === "file")!;
    expect(file.content).toContain('import jwt from "jsonwebtoken";');
    expect(file.content).toContain("authMiddleware");

    const module = chunks.find((c) => c.kind === "module")!;
    expect(module.content).toContain('router.get("/me"');
  });

  it("splits large classes into a skeleton plus member chunks", async () => {
    const methods = Array.from({ length: 12 }, (_, i) => `  method${i}(x: number): number {\n${"    x = x + 1;\n".repeat(20)}    return x;\n  }`).join("\n");
    const src = `export class Big {\n${methods}\n}\n`;
    const chunks = await chunkAst(ts, src, "big.ts", { maxChars: 1500 });
    const skeleton = chunks.find((c) => c.kind === "class")!;
    expect(skeleton.content).toContain("method3(x: number): number … [L");
    const m = chunks.find((c) => c.name === "method7")!;
    expect(m.kind).toBe("method");
    expect(m.symbolPath).toBe("Big.method7");
    expect(m.parentScope).toBe("Big");
  });

  it("splits oversized functions on statement boundaries", async () => {
    const body = Array.from({ length: 80 }, (_, i) => `  const v${i} = compute(${i}, "${"x".repeat(30)}");`).join("\n");
    const src = `function huge() {\n${body}\n}\n`;
    const chunks = (await chunkAst(ts, src, "huge.ts", { maxChars: 1200 })).filter((c) => c.name === "huge");
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.part && c.part.total === chunks.length)).toBe(true);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.startLine).toBe(chunks[i - 1]!.endLine + 1);
    expect(chunks.every((c) => c.content.length <= 1200)).toBe(true);
  });
});

describe("AST chunker (Python)", () => {
  const PY = `"""Session handling for the API client."""
import os
from .auth import HTTPBasicAuth


class Session:
    """A persistent HTTP session."""

    def __init__(self):
        self.headers = {}

    @property
    def auth(self):
        """Current auth handler."""
        return self._auth


def request(method, url, **kwargs):
    """Sends a request."""
    with Session() as s:
        return s.request(method=method, url=url, **kwargs)
`;

  it("captures docstrings, decorators and class scope", async () => {
    const chunks = await chunkAst(py, PY, "requests/sessions.py", { maxChars: 3500 });
    const cls = chunks.find((c) => c.name === "Session")!;
    expect(cls.kind).toBe("class");
    expect(cls.docstring).toBe("A persistent HTTP session.");
    const fn = chunks.find((c) => c.name === "request")!;
    expect(fn.docstring).toBe("Sends a request.");
    expect(fn.signature).toBe("def request(method, url, **kwargs)");
    const file = chunks.find((c) => c.kind === "file")!;
    expect(file.docstring).toBe("Session handling for the API client.");
    expect(file.content).toContain("from .auth import HTTPBasicAuth");
  });

  it("chunks methods individually when the class is large", async () => {
    const chunks = await chunkAst(py, PY, "requests/sessions.py", { maxChars: 150 });
    const auth = chunks.find((c) => c.name === "auth")!;
    expect(auth.kind).toBe("method");
    expect(auth.symbolPath).toBe("Session.auth");
    expect(auth.content).toContain("@property");
    expect(auth.startLine).toBe(12);
  });
});

describe("AST chunker (other grammars)", () => {
  it("handles C++ qualified methods and Go receivers", async () => {
    const cpp = await chunkAst(AST_LANGUAGES.cpp!, "namespace net {\nvoid Server::run(int port) {\n  listen(port);\n}\n}\n", "server.cc", { maxChars: 3500 });
    const run = cpp.find((c) => c.name === "run")!;
    expect(run.symbolPath).toBe("net.Server.run");
    expect(run.kind).toBe("method");

    const go = await chunkAst(AST_LANGUAGES.go!, "package main\n\n// Handle serves requests.\nfunc (s *Server) Handle(w http.ResponseWriter) error {\n\treturn nil\n}\n", "server.go", { maxChars: 3500 });
    const handle = go.find((c) => c.name === "Handle")!;
    expect(handle.symbolPath).toBe("Server.Handle");
    expect(handle.docstring).toBe("Handle serves requests.");
  });

  it("handles Rust impl blocks and Java classes", async () => {
    const rs = await chunkAst(AST_LANGUAGES.rust!, "/// Adds\npub fn add(a: i32) -> i32 { a }\nimpl Display for Point {\n    fn fmt(&self) {}\n}\n", "lib.rs", { maxChars: 3500 });
    expect(rs.find((c) => c.name === "add")!.docstring).toBe("Adds");
    expect(rs.find((c) => c.kind === "class")!.name).toBe("Point(Display)");

    const java = await chunkAst(AST_LANGUAGES.java!, "public class A {\n  public void run() {}\n}\n", "A.java", { maxChars: 3500 });
    expect(java.find((c) => c.name === "A")!.kind).toBe("class");
  });
});

describe("text chunkers", () => {
  it("splits markdown by heading breadcrumbs", () => {
    const md = "# Guide\nIntro text for the guide.\n## Setup\nRun npm install and configure env.\n## Usage\nCall the API with a token.\n";
    const chunks = chunkMarkdown(md, "README.md", 3500);
    expect(chunks.map((c) => c.symbolPath)).toEqual(["Guide", "Guide > Setup", "Guide > Usage"]);
  });

  it("fixed chunker produces overlapping windows", () => {
    const src = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const chunks = chunkFixed(src, "a.txt", 1000);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks[1]!.startLine).toBeLessThanOrEqual(chunks[0]!.endLine);
    expect(chunks.at(-1)!.endLine).toBe(100);
  });

  it("maps extensions to strategies", () => {
    expect(strategyForPath("src/a.tsx")).toMatchObject({ kind: "ast", language: "typescript" });
    expect(strategyForPath("docs/x.md")).toMatchObject({ kind: "markdown" });
    expect(strategyForPath("app/Main.kt")).toMatchObject({ kind: "text", language: "kotlin" });
    expect(strategyForPath("logo.png")).toBeUndefined();
  });
});

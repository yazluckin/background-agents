import type { Logger } from "../../../logger";
import type { ParticipantRole } from "../../../types";
import type { OpenAITokenRefreshResult } from "../../openai-token-refresh-service";
import type { SessionRepository } from "../../repository";
import type { SandboxEventWithAck, SandboxRow, SessionRow } from "../../types";

interface AddParticipantRequest {
  userId: string;
  scmLogin?: string;
  scmName?: string;
  scmEmail?: string;
  role?: string;
}

export interface SandboxHandlerDeps {
  repository: Pick<SessionRepository, "createParticipant">;
  processSandboxEvent: (event: SandboxEventWithAck) => Promise<void>;
  getSandbox: () => SandboxRow | null;
  isValidSandboxToken: (token: string | null, sandbox: SandboxRow | null) => Promise<boolean>;
  getSession: () => SessionRow | null;
  refreshOpenAIToken: (session: SessionRow) => Promise<OpenAITokenRefreshResult>;
  isOpenAISecretsConfigured: () => boolean;
  generateId: () => string;
  now: () => number;
  getLog: () => Logger;
}

export interface SandboxHandler {
  sandboxEvent: (request: Request) => Promise<Response>;
  addParticipant: (request: Request) => Promise<Response>;
  verifySandboxToken: (request: Request) => Promise<Response>;
  openaiTokenRefresh: () => Promise<Response>;
}

export function createSandboxHandler(deps: SandboxHandlerDeps): SandboxHandler {
  return {
    async sandboxEvent(request: Request): Promise<Response> {
      const event = (await request.json()) as SandboxEventWithAck;
      await deps.processSandboxEvent(event);
      return Response.json({ status: "ok" });
    },

    async addParticipant(request: Request): Promise<Response> {
      const body = (await request.json()) as AddParticipantRequest;

      const id = deps.generateId();
      const now = deps.now();

      deps.repository.createParticipant({
        id,
        userId: body.userId,
        scmLogin: body.scmLogin ?? null,
        scmName: body.scmName ?? null,
        scmEmail: body.scmEmail ?? null,
        role: (body.role ?? "member") as ParticipantRole,
        joinedAt: now,
      });

      return Response.json({ id, status: "added" });
    },

    async verifySandboxToken(request: Request): Promise<Response> {
      const body = (await request.json()) as { token: string };

      if (!body.token) {
        return Response.json({ valid: false, error: "Missing token" }, { status: 400 });
      }

      const sandbox = deps.getSandbox();
      if (!sandbox) {
        deps.getLog().warn("Sandbox token verification failed: no sandbox");
        return Response.json({ valid: false, error: "No sandbox" }, { status: 404 });
      }

      if (sandbox.status === "stopped" || sandbox.status === "stale") {
        deps.getLog().warn("Sandbox token verification failed: sandbox is stopped/stale", {
          status: sandbox.status,
        });
        return Response.json({ valid: false, error: "Sandbox stopped" }, { status: 410 });
      }

      const isTokenValid = await deps.isValidSandboxToken(body.token, sandbox);
      if (!isTokenValid) {
        deps.getLog().warn("Sandbox token verification failed: token mismatch");
        return Response.json({ valid: false, error: "Invalid token" }, { status: 401 });
      }

      deps.getLog().info("Sandbox token verified successfully");
      return Response.json({ valid: true });
    },

    async openaiTokenRefresh(): Promise<Response> {
      const session = deps.getSession();
      if (!session) {
        return Response.json({ error: "No session" }, { status: 404 });
      }

      if (!deps.isOpenAISecretsConfigured()) {
        return Response.json({ error: "Secrets not configured" }, { status: 500 });
      }

      const result = await deps.refreshOpenAIToken(session);
      if (!result.ok) {
        return Response.json({ error: result.error }, { status: result.status });
      }

      return Response.json(
        {
          access_token: result.accessToken,
          expires_in: result.expiresIn,
          account_id: result.accountId,
        },
        { status: 200 }
      );
    },
  };
}

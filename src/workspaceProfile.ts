import * as Y from "yjs";

import {
  joinWorkspace,
  loadDoc,
  type WorkspaceSocket,
} from "./ws.js";

export type WorkspaceProfile = {
  name: string | null;
  avatar: string | null;
};

export type WorkspaceProfileDependencies = {
  joinWorkspace: typeof joinWorkspace;
  loadDoc: typeof loadDoc;
};

/** Read the profile metadata stored in a workspace root document. */
export async function readWorkspaceProfile(
  socket: WorkspaceSocket,
  workspaceId: string,
  dependencyOverrides: Partial<WorkspaceProfileDependencies> = {},
): Promise<WorkspaceProfile> {
  await (dependencyOverrides.joinWorkspace ?? joinWorkspace)(socket, workspaceId);
  const snapshot = await (dependencyOverrides.loadDoc ?? loadDoc)(socket, workspaceId, workspaceId);
  if (typeof snapshot.missing !== "string") {
    throw new Error(`Workspace profile metadata is unavailable for ${workspaceId}.`);
  }

  const workspaceDoc = new Y.Doc();
  Y.applyUpdate(workspaceDoc, Buffer.from(snapshot.missing, "base64"));
  const meta = workspaceDoc.getMap("meta");
  const name = meta.get("name");
  const avatar = meta.get("avatar");
  return {
    name: typeof name === "string" ? name : null,
    avatar: typeof avatar === "string" ? avatar : null,
  };
}

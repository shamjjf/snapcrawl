import type { Response } from "express";
import { asyncHandler, requireUser } from "../../http/validate";
import type { ExtRequest } from "../../middleware/extAuth";
import { ProjectModel } from "../../models/project";
import { serializeProject, visibilityFilter } from "../projects/service";

// GET /ext/projects — projects the token's user can run, for popup selection
// (FR-EX-002). Same serialized shape as the panel, incl. the run config.
export const extProjects = asyncHandler(async (req: ExtRequest, res: Response) => {
  const user = requireUser(req);
  const docs = await ProjectModel.find(visibilityFilter(user))
    .sort({ createdAt: -1 })
    .limit(100);
  res.json({ items: docs.map(serializeProject) });
});

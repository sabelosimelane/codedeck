import { getProjectLocation, LOCAL_HOST } from '../project-config.js';

export function isLocalProject(project) {
  if (!project || typeof project !== 'object' || typeof project.name !== 'string' || !project.name) throw new TypeError('Invalid assistant project');
  return getProjectLocation(project, project.defaultHost)?.host === LOCAL_HOST;
}

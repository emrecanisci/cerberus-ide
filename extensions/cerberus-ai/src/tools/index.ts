import { CerberusTool } from './types';
import { editFileTool, listDirectoryTool, readFileTool, searchFilesTool, writeFileTool } from './fs-tools';
import { runTerminalTool } from './terminal';

export { CerberusTool } from './types';

export const ALL_TOOLS: ReadonlyArray<CerberusTool> = [
	readFileTool,
	writeFileTool,
	editFileTool,
	listDirectoryTool,
	searchFilesTool,
	runTerminalTool,
];

export function toolsForGateway(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
	return ALL_TOOLS.map(t => ({
		name: t.name,
		description: t.description,
		input_schema: t.inputSchema,
	}));
}

export function findTool(name: string): CerberusTool | undefined {
	return ALL_TOOLS.find(t => t.name === name);
}

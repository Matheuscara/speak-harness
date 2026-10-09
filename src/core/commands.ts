import type { Command, CommandRegistry } from "./types.ts";

export function createCommandRegistry(): CommandRegistry {
  const commands = new Map<string, Command>();
  return {
    register(command) {
      if (commands.has(command.id)) throw new Error(`Command "${command.id}" is already registered`);
      commands.set(command.id, command);
      return () => {
        if (commands.get(command.id) === command) commands.delete(command.id);
      };
    },
    get: (id) => commands.get(id),
    list: () => [...commands.values()],
    async run(id, args = []) {
      const command = commands.get(id);
      if (!command) throw new Error(`Unknown command "${id}"`);
      await command.run(args);
    },
  };
}

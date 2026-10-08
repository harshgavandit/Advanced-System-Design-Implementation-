export type MongoServerDescription = { address: string; type: string };

const isUp = (type: string): boolean =>
  type === "RSPrimary" || type === "RSSecondary" || type === "Standalone";

export function uniqueMongoMembers(servers: Map<string, MongoServerDescription>): MongoServerDescription[] {
  const members = new Map<string, MongoServerDescription>();
  for (const server of servers.values()) {
    // The local host alias can describe the same endpoint. Different hosts on
    // the same port are separate members, as in container and Atlas clusters.
    const endpoint = server.address.replace(/^host\.docker\.internal(?=:)/, "127.0.0.1");
    const previous = members.get(endpoint);
    if (!previous || isUp(server.type)) members.set(endpoint, server);
  }
  return [...members.values()];
}

export function nodeServerProcesses(output) {
  return output.split(/\r?\n/).filter(row => /^\s*\d+\s+\d+\s+\S+\s+(?:\S*\/)?node\s+(?:\S*\/)?dist\/server\.js(?:\s|$)/.test(row));
}

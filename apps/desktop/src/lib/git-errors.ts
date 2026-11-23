/**
 * Git's own words for "this folder is not a repository" ("fatal: not a git repository (or any of
 * the parent directories): .git"). The Changes view treats it as a state with a way out (start a
 * repository), not as a failure to print.
 */
export function isNotRepoError(message: string): boolean {
  return /not a git repository/i.test(message);
}

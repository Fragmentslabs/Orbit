import { promises as fs } from "node:fs"
import path from "node:path"

const PLAN_FILENAME = "PLAN.md"

export async function savePlanFile(directory: string, content: string): Promise<void> {
  const filePath = path.join(directory, PLAN_FILENAME)
  await fs.writeFile(filePath, content, "utf-8")
}

export async function deletePlanFile(directory: string): Promise<void> {
  const filePath = path.join(directory, PLAN_FILENAME)
  try {
    await fs.unlink(filePath)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
}

export async function readPlanFile(directory: string): Promise<string | null> {
  const filePath = path.join(directory, PLAN_FILENAME)
  try {
    return await fs.readFile(filePath, "utf-8")
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

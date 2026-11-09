import { claimPark, findPark } from "../../src/parking.js"
import { jsonFile } from "../../src/store.js"

const path = process.argv[2]
if (path === undefined) throw new Error("parked index path missing")
const file = jsonFile(path)
const record = await findPark(file, "shared")
console.log(record === undefined ? false : await claimPark(file, record, 2_000))

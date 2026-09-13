import "dotenv/config";
import cors from "cors";
import express from "express";
import { storesRouter } from "./routes/stores.js";
import { deliveriesRouter } from "./routes/deliveries.js";
import { searchRouter } from "./routes/search.js";

const app = express();
const port = process.env.PORT ?? 4000;

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/stores", storesRouter);
app.use("/api/deliveries", deliveriesRouter);
app.use("/api/search", searchRouter);

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

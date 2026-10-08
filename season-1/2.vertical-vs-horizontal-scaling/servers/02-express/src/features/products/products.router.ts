import { Router } from "express";
import * as controller from "./products.controller.js";
import { requireAuth, requireAdmin } from "../../shared/auth.js";

const router = Router();

/**
 * @openapi
 * /products:
 *   get:
 *     summary: List products - supports both offset (page/limit) and cursor pagination
 *     tags: [Products]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *         description: If given, uses offset pagination - response includes totalItems/totalPages
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *         description: Last _id from the previous page - ignored if "page" is given
 *       - in: query
 *         name: name
 *         schema: { type: string }
 *         description: Word search on product name (text index)
 *       - in: query
 *         name: limit
 *         schema: { type: integer, maximum: 100, default: 20 }
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *     responses:
 *       200: { description: Paginated product list (shape depends on page vs cursor mode) }
 *       500: { description: Something went wrong. Please try again later. }
 */
router.get("/", controller.list);

/**
 * @openapi
 * /products/ingest/stats:
 *   get:
 *     summary: Durable ingestion counters shared by every replica
 *     tags: [Products]
 *     responses:
 *       200: { description: accepted queued flushed failed }
 */
router.get("/ingest/stats", requireAuth, requireAdmin, controller.ingestStats);

/**
 * @openapi
 * /products/ingest:
 *   post:
 *     summary: Accept a product job after its majority-committed job and outbox
 *     tags: [Products]
 *     responses:
 *       202: { description: Durable acceptance, returns jobId and status }
 *       409: { description: Idempotency key payload conflict }
 *       429: { description: Admission backlog is full }
 *       400: { description: Validation error }
 */
router.post("/ingest", requireAuth, requireAdmin, controller.ingest);

/**
 * @openapi
 * /products/{id}:
 *   get:
 *     summary: Get product by id
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Product }
 *       404: { description: Not found }
 */
router.get("/:id", controller.getById);

/**
 * @openapi
 * /products:
 *   post:
 *     summary: Create product
 *     tags: [Products]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, description, price, stock, category, imageUrl]
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               price: { type: number }
 *               stock: { type: integer }
 *               category: { type: string }
 *               imageUrl: { type: string }
 *     responses:
 *       201: { description: Created }
 *       400: { description: Validation error }
 */
router.post("/", requireAuth, requireAdmin, controller.create);

/**
 * @openapi
 * /products/{id}:
 *   put:
 *     summary: Update product
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Updated }
 *       404: { description: Not found }
 */
router.put("/:id", requireAuth, requireAdmin, controller.update);

/**
 * @openapi
 * /products/{id}:
 *   delete:
 *     summary: Delete product
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Deleted }
 *       404: { description: Not found }
 */
router.delete("/:id", requireAuth, requireAdmin, controller.remove);

export default router;

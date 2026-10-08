import type { Request, Response } from "express";
import { Product } from "./products.model.js";
import * as validate from "./products.validation.js";
import { acceptIngestion, ingestionStats } from "../ingestion/service.js";
import { httpError } from "../../shared/error.js";
import {mutation,sendMutation} from '../../shared/mutations.js';
import {invalidateCatalog,readCatalog} from './products.cache.js';
import {
  parseLimit,
  parsePage,
  buildCursorFilter,
  buildNextCursor,
} from "../../shared/pagination.js";

// Express 5: async handlers ke rejected promises (throw included) khud errorHandler tak forward ho jaate hain

const buildListFilter = (query: Request["query"]): Record<string, unknown> => {
  const filter: Record<string, unknown> = {};
  if (typeof query.category === "string" && query.category.trim()) {
    if (query.category.length > 100) throw httpError(400, "category is too long");
    filter.category = query.category.trim();
  }
  if (typeof query.name === "string" && query.name.trim()) {
    if (query.name.length > 200) throw httpError(400, "name is too long");
    const term = query.name.trim().replace(/"/g, "");
    if (term) filter.$text = { $search: term };
  }
  return filter;
};

// GET /products?page=&limit=      -> offset pagination (page numbers, totalPages)
// GET /products?cursor=&limit=    -> cursor pagination (default when no "page" query given)
export const list = async (req: Request, res: Response): Promise<void> => {
  const limit = parseLimit(req.query.limit);
  const baseFilter = buildListFilter(req.query);

  if (req.query.page !== undefined) {
    const page = parsePage(req.query.page);
    const skip = (page - 1) * limit;
    if (!Number.isSafeInteger(skip) || skip > 10000) throw httpError(400, "Use cursor pagination beyond 10000 items");
    const hasFilter = Object.keys(baseFilter).length > 0;

    // countDocuments({}) walks the whole collection even with indexes present (tested:
    // 22s on 40M docs) - estimatedDocumentCount() reads collection metadata instead
    // (~4ms) and is the standard fix for an unfiltered total. A real filter (category)
    // narrows the scan enough that the exact count stays cheap.
    res.json(await readCatalog(req,res,{kind:'offset',page,limit,filter:baseFilter},async()=>{
      const [items,totalItems]=await Promise.all([
        Product.find(baseFilter).sort({_id:1}).skip(skip).limit(limit).maxTimeMS(2000).lean(),
        hasFilter?Product.countDocuments(baseFilter).maxTimeMS(2000):Product.estimatedDocumentCount().maxTimeMS(2000),
      ]);
      return {items,page,limit,totalItems,totalItemsExact:hasFilter,totalPages:Math.ceil(totalItems/limit)};
    },page<=3 && !baseFilter.$text));
    return;
  }

  const filter = { ...baseFilter, ...buildCursorFilter(req.query.cursor) };
  res.json(await readCatalog(req,res,{kind:'cursor',cursor:req.query.cursor??null,limit,filter:baseFilter},async()=>{
    const items=await Product.find(filter).sort({_id:1}).limit(limit).maxTimeMS(2000).lean();
    return {items,nextCursor:buildNextCursor(items,limit)};
  },!req.query.cursor && !baseFilter.$text));
};

export const getById = async (req: Request, res: Response): Promise<void> => {
  const id=String(req.params.id).toLowerCase();
  if(!/^[a-f0-9]{24}$/.test(id))throw httpError(400,'Invalid product ID');
  const product=await readCatalog(req,res,`item:${id}`,()=>Product.findById(id).maxTimeMS(2000).lean());
  if (!product) throw httpError(404, "Product not found");
  res.json(product);
};

export const create = async (req: Request, res: Response): Promise<void> => {
  const payload = validate.validateCreate(req.body);
  const row=await mutation(req,'product-created',payload,async session=>{
    const [product]=await Product.create([payload],{session});
    return {status:201,body:product,target:String(product._id)};
  });
  await invalidateCatalog(String(row.body._id));
  sendMutation(res,row);
};

export const ingest = async (req: Request, res: Response): Promise<void> => {
  const payload = validate.validateCreate(req.body);
  res.status(202).json(await acceptIngestion(req.user!.id, req.get('Idempotency-Key'), payload));
};

export const ingestStats = async (_req: Request, res: Response): Promise<void> => {
  res.json(await ingestionStats());
};

export const update = async (req: Request, res: Response): Promise<void> => {
  const patch = validate.validateUpdate(req.body);
  const row=await mutation(req,'product-updated',patch,async session=>{
    const product=await Product.findByIdAndUpdate(req.params.id,patch,{new:true,runValidators:true,session});
    if(!product) throw httpError(404,'Product not found');
    return {status:200,body:product,target:String(product._id)};
  });
  await invalidateCatalog(String(row.body._id));
  sendMutation(res,row);
};

export const remove = async (req: Request, res: Response): Promise<void> => {
  const row=await mutation(req,'product-deleted',{},async session=>{
    const product=await Product.findByIdAndDelete(req.params.id,{session});
    if(!product) throw httpError(404,'Product not found');
    return {status:200,body:{deleted:product},target:String(product._id)};
  });
  await invalidateCatalog(String(req.params.id));
  sendMutation(res,row);
};

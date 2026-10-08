import type { Request, Response } from "express";
import mongoose from "mongoose";
import { CartItem } from "./cart.model.js";
import * as validate from "./cart.validation.js";
import { httpError } from "../../shared/error.js";
import { parseLimit, buildCursorFilter, buildNextCursor } from "../../shared/pagination.js";
import {mutation,sendMutation} from '../../shared/mutations.js';
import {Product} from '../products/products.model.js';

// Express 5: async handlers ke rejected promises (throw included) khud errorHandler tak forward ho jaate hain

export const list = async (req: Request, res: Response): Promise<void> => {
  const limit = parseLimit(req.query.limit);
  const filter = buildCursorFilter(req.query.cursor);
  const userId = req.user!.id;

  const items = await CartItem.find({ ...filter, userId }).read('primary').readConcern('majority').maxTimeMS(2000).sort({ _id: 1 }).limit(limit).populate({path:'productId',options:{readPreference:'primary',maxTimeMS:2000}}).lean();

  // total cart value = poore cart ka sum (page-wise nahi), isliye alag aggregation
  const totalAgg = await CartItem.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(userId) } },
    {
      $lookup: {
        from: "products",
        localField: "productId",
        foreignField: "_id",
        as: "product",
      },
    },
    { $unwind: "$product" },
    {
      $group: {
        _id: null,
        total: { $sum: { $multiply: ["$product.price", "$qty"] } },
      },
    },
  ]).option({maxTimeMS:2000,readPreference:'primary',readConcern:{level:'majority'}});
  const total = totalAgg[0]?.total ?? 0;

  res.json({ items, nextCursor: buildNextCursor(items, limit), total });
};

export const getById = async (req: Request, res: Response): Promise<void> => {
  const item = await CartItem.findOne({ _id: req.params.id, userId: req.user!.id }).read('primary').readConcern('majority').maxTimeMS(2000).populate({path:'productId',options:{readPreference:'primary',maxTimeMS:2000}}).lean();
  if (!item) throw httpError(404, "Cart item not found");
  res.json(item);
};

export const add = async (req: Request, res: Response): Promise<void> => {
  const payload = validate.validateAdd(req.body);
  const userId = req.user!.id;

  const row=await mutation(req,'cart-added',payload,async session=>{
    if (!await Product.exists({_id:payload.productId}).session(session)) throw httpError(404,'Product not found');
    const existing=await CartItem.findOne({userId,productId:payload.productId}).session(session).lean();
    if ((existing?.qty??0)+payload.qty>1000000) throw httpError(409,'Cart quantity limit reached');
    const item=await CartItem.findOneAndUpdate({userId,productId:payload.productId},{$inc:{qty:payload.qty}},{upsert:true,new:true,session});
    return {status:existing?200:201,body:item,target:String(item!._id)};
  },true);
  sendMutation(res,row);
};

export const update = async (req: Request, res: Response): Promise<void> => {
  const patch = validate.validateUpdate(req.body);
  sendMutation(res,await mutation(req,'cart-updated',patch,async session=>{
    const item=await CartItem.findOneAndUpdate({_id:req.params.id,userId:req.user!.id},patch,{new:true,runValidators:true,session});
    if (!item) throw httpError(404,'Cart item not found');
    return {status:200,body:item,target:String(item._id)};
  }));
};

export const adjustQuantity = async (req: Request, res: Response): Promise<void> => {
  const delta = validate.validateQuantityDelta(req.body);
  const userId = req.user!.id;
  sendMutation(res,await mutation(req,'cart-adjusted',{delta},async session=>{
    const existing=await CartItem.findOne({_id:req.params.id,userId}).session(session).lean();
    if (!existing) throw httpError(404,'Cart item not found');
    if (existing.qty+delta>1000000) throw httpError(409,'Cart quantity limit reached');
    const item=await CartItem.findOneAndUpdate({_id:req.params.id,userId,...(delta<0?{qty:{$gt:-delta}}:{})},{$inc:{qty:delta}},{new:true,session});
    if(item) return {status:200,body:item,target:String(item._id)};
    // Guard the deletion too, and keep both decisions in the same transaction.
    // A concurrent increment conflicts and retries from a fresh snapshot.
    const deleted=await CartItem.findOneAndDelete({_id:req.params.id,userId,qty:{$lte:-delta}},{session});
    if (!deleted) throw httpError(404,'Cart item not found');
    return {status:200,body:{deleted},target:String(deleted._id)};
  }));
};

export const remove = async (req: Request, res: Response): Promise<void> => {
  sendMutation(res,await mutation(req,'cart-deleted',{},async session=>{
    const item=await CartItem.findOneAndDelete({_id:req.params.id,userId:req.user!.id},{session});
    if(!item) throw httpError(404,'Cart item not found');
    return {status:200,body:{deleted:item},target:String(item._id)};
  }));
};

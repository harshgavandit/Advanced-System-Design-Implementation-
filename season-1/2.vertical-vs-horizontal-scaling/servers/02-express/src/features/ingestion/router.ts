import {Router} from 'express';
import {requireAuth, requireAdmin} from '../../shared/auth.js';
import {getJob, redrive} from './service.js';
const router=Router();
router.get('/:id',requireAuth,async (req,res)=>{ res.json(await getJob(String(req.params.id),req.user!.id,req.user!.role==='admin')); });
router.post('/:id/redrive',requireAuth,requireAdmin,async (req,res)=>{ res.status(202).json(await redrive(String(req.params.id),req.user!.id)); });
export default router;

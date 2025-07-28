// Middleware to check userId and hasExclusivePlan

import { clerkClient } from "@clerk/express";

export const auth = async (req, res, next)=>{
    try {
        const {userId, has} = await req.auth();
        const hasExclusivePlan = has({plan: 'exclusive'});

        const user = await clerkClient.users.getUser(userId);

        if(!hasExclusivePlan && user.privateMetadata.free_usage){
            req.free_usage = user.privateMetadata.free_usage
        } else{
            await clerkClient.users.updateUserMetadata(userId, {
               privateMetadata: {
                free_usage: 0
               }
            })
            req.free_usage = 0;
        }

        req.plan = hasExclusivePlan ? 'exclusive' : 'free';
        next()
    } catch (error) {
        res.json({success: false, message: error.message})
    }

}
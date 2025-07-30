import OpenAI from "openai";
import sql from "../configs/db.js";
import { clerkClient } from "@clerk/express";
import axios from "axios";
import {v2 as cloudinary} from 'cloudinary';
import FormData from 'form-data';
import fs from 'fs';
import pdf from 'pdf-parse/lib/pdf-parse.js'


const AI = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
});

export const generateArticle = async (req, res)=> {
    try {
        const {userId} = req.auth();
        const {prompt, length} = req.body;
        const plan = req.plan;
        const free_usage = req.free_usage;

        if(plan !== 'exclusive' && free_usage >= 10){
            return res.json({sucess: false, message: 'Limit reached. Upgrade to continue.'})
        }

        const maxTokens = Math.ceil(length * 1.5);

        const response = await AI.chat.completions.create({
            model: "gemini-2.0-flash",
            messages: [{
                    role: "user",
                    content: prompt,
                },
            ],
            temperature: 0.7,
            max_tokens: maxTokens,
        });

        const content = response.choices[0].message.content
        await sql`INSERT INTO creations (user_id, prompt, content, type) VALUES (${userId}, ${prompt}, ${content}, 'article')`;

        if(plan !== 'exclusive'){
            await clerkClient.users.updateUserMetadata(userId, {
                privateMetadata: {
                    free_usage: free_usage + 1
                }
            })
        }

        res.json({success: true, content})
    } catch (error) {
        console.log(error.message);
        res.json({success: false, message: error.message})
        
    }

}



export const generateBlogTitle = async (req, res)=> {
    try {
        const {userId} = req.auth();
        const {prompt} = req.body;
        const plan = req.plan;
        const free_usage = req.free_usage;

        if(plan !== 'exclusive' && free_usage >= 10){
            return res.json({success: false, message: 'Limit reached. Upgrade to continue.'})
        }

        const response = await AI.chat.completions.create({
            model: "gemini-2.0-flash",
            messages: [{role: "user", content: prompt, } ],
            temperature: 0.7,
            max_tokens: 1000,
        });

        const content = response.choices[0].message.content
        await sql`INSERT INTO creations (user_id, prompt, content, type) VALUES (${userId}, ${prompt}, ${content}, 'blog-title')`;

        if(plan !== 'exclusive'){
            await clerkClient.users.updateUserMetadata(userId, {
                privateMetadata: {
                    free_usage: free_usage + 1
                }
            })
        }

        res.json({success: true, content})
    } catch (error) {
        console.log(error.message);
        res.json({success: false, message: error.message})
        
    }

}



export const generateImage = async (req, res) => {
  try {
    const { userId } = req.auth();
    const { prompt, publish } = req.body;
    const plan = req.plan;

    if (plan !== 'exclusive') {
      return res.json({ success: false, message: 'This feature is only available for exclusive subscriptions' });
    }

    const response = await fetch("https://api.infip.pro/v1/images/generations", {
      method: 'POST',
      headers: {
        "Authorization": `Bearer ${process.env.INFIP_API_KEY}`, // Make sure to set this in your .env file
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "img3",
        prompt: prompt,
        num_images: 1,
        size: "1024x1024"
      })
    });

    const data = await response.json();

    if (!response.ok || !data.data || !data.data[0].url) {
      throw new Error(data.message || 'Image generation failed');
    }

    const imageUrl = data.data[0].url;

    // Upload to Cloudinary from URL
    const uploaded = await cloudinary.uploader.upload(imageUrl, {
      folder: "generated_images"
    });

    const secure_url = uploaded.secure_url;

    // Save to DB
    await sql`INSERT INTO creations (user_id, prompt, content, type, publish) VALUES (${userId}, ${prompt}, ${secure_url}, 'image', ${publish ?? false})`;

    res.json({ success: true, secure_url });
  } catch (error) {
    console.error(error);
    res.json({ success: false, message: error.message });
  }
};


export const removeImageBackground = async (req, res) => {
  try {
    const {userId} = req.auth();
    const image = req.file;
    const plan = req.plan;

    if(plan !== 'exclusive'){
      return res.join({success: false, message: "This feature is only available for exclusive subscriptions"})
    }

    const {secure_url} = await cloudinary.uploader.upload(image.path, {
      transformation: [
        {
          effect: 'background_removal',
          background_removal: 'remove_the_background'
        }
      ]
    })

    await sql`INSERT INTO creations(user_id, prompt, content, type) VALUES (${userId}, 'Remove background from image', ${secure_url}, 'image')`;

    res.json({success: true, content: secure_url})

  } catch (error) {
    console.log(error.message);
    res.json({success: false, message: error.message})
  }

}

export const removeImageObject = async (req, res) => {
  try {
    const {userId} = req.auth();
    const {object} = req.body;
    const image = req.file;
    const plan = req.plan;

    if(plan !== 'exclusive'){
      return res.join({success: false, message: "This feature is only available for exclusive subscriptions"})
    }

    const {public_id} = await cloudinary.uploader.upload(image.path)

    const imageUrl = cloudinary.url(public_id, {
      transformation: [{effect: `gen_remove:${object.trim()}`}],
      resource_type: 'image'
    })

    await sql`INSERT INTO creations(user_id, prompt, content, type) VALUES (${userId}, ${`Removed ${object} from image`}, ${imageUrl}, 'image')`;

    res.json({success: true, content: imageUrl})

  } catch (error) {
    console.log(error.message);
    res.json({success: false, message: error.message})
  }

}


export const resumeReview = async (req, res) => {
  try {
    const {userId} = req.auth();
    const resume = req.file;
    const plan = req.plan;

    if(plan !== 'exclusive'){
      return res.join({success: false, message: "This feature is only available for exclusive subscriptions"})
    }

    if(resume.size > 5 * 1024 * 1024){
      return res.json({success: false, message: "Resume file size exceeds allowed size (5MB)."})
    }

    const dataBuffer = fs.readFileSync(resume.path)
    const pdfData = await pdf(dataBuffer)

    const prompt = `Review the following resume and provide constructive feedback on its strengths, weakness, and areas for improvements. Resume Content:\n\n${pdfData.text}`
    const response = await AI.chat.completions.create({
            model: "gemini-2.0-flash",
            messages: [{
                    role: "user",
                    content: prompt,
                },
            ],
            temperature: 0.7,
            max_tokens: 1000,
        });

        const content = response.choices[0].message.content

    await sql`INSERT INTO creations(user_id, prompt, content, type) VALUES (${userId}, 'Review the uploaded resume', ${content}, 'resume-review')`;

    res.json({success: true, content: content})

  } catch (error) {
    console.log(error.message);
    res.json({success: false, message: error.message})
  }

}

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
    const {jobRole} = req.body;
    const plan = req.plan;

    if(plan !== 'exclusive'){
      return res.join({success: false, message: "This feature is only available for exclusive subscriptions"})
    }

    if(resume.size > 5 * 1024 * 1024){
      return res.json({success: false, message: "Resume file size exceeds allowed size (5MB)."})
    }

    const dataBuffer = fs.readFileSync(resume.path)
    const pdfData = await pdf(dataBuffer)

    const roleSpecificPrompts = {
      'frontend-developer': `Review this resume for a Frontend Developer position. Focus on:
- HTML, CSS, JavaScript, React, Vue, Angular, or other frontend frameworks
- Responsive design and mobile-first development
- Performance optimization and accessibility
- Modern frontend build tools and workflows
- UI/UX principles and design systems`,
      
      'backend-developer': `Review this resume for a Backend Developer position. Focus on:
- Server-side programming languages (Node.js, Python, Java, C#, etc.)
- Database design and management (SQL, NoSQL)
- API development and RESTful services
- Authentication and security practices
- System architecture and scalability`,
      
      'fullstack-developer': `Review this resume for a Full Stack Developer position. Focus on:
- Both frontend and backend technologies
- Database design and API development
- Modern development frameworks and tools
- DevOps practices and deployment
- End-to-end application development`,
      
      'mobile-developer': `Review this resume for a Mobile Developer position. Focus on:
- iOS development (Swift, Objective-C) or Android development (Kotlin, Java)
- Cross-platform frameworks (React Native, Flutter, Xamarin)
- Mobile app architecture and design patterns
- App store deployment and distribution
- Mobile-specific performance optimization`,
      
      'devops-engineer': `Review this resume for a DevOps Engineer position. Focus on:
- CI/CD pipelines and automation tools
- Cloud platforms (AWS, Azure, GCP)
- Containerization (Docker, Kubernetes)
- Infrastructure as Code (Terraform, CloudFormation)
- Monitoring, logging, and observability`,
      
      'data-scientist': `Review this resume for a Data Scientist position. Focus on:
- Statistical analysis and machine learning
- Programming languages (Python, R, SQL)
- Data visualization and storytelling
- Big data technologies (Hadoop, Spark)
- Business intelligence and analytics`,
      
      'machine-learning-engineer': `Review this resume for a Machine Learning Engineer position. Focus on:
- ML algorithms and model development
- Deep learning frameworks (TensorFlow, PyTorch)
- MLOps and model deployment
- Data preprocessing and feature engineering
- Model performance optimization`,
      
      'software-architect': `Review this resume for a Software Architect position. Focus on:
- System design and architecture patterns
- Scalability and performance considerations
- Technology stack selection and evaluation
- Code quality and maintainability
- Technical leadership and mentoring`,
      
      'product-manager': `Review this resume for a Product Manager position. Focus on:
- Product strategy and roadmap development
- User research and market analysis
- Agile methodologies and project management
- Stakeholder communication and leadership
- Data-driven decision making`,
      
      'ui-ux-designer': `Review this resume for a UI/UX Designer position. Focus on:
- User interface design and prototyping
- User experience research and testing
- Design tools (Figma, Sketch, Adobe Creative Suite)
- Design systems and component libraries
- Accessibility and inclusive design`,
      
      'qa-engineer': `Review this resume for a QA Engineer position. Focus on:
- Test planning and strategy
- Manual and automated testing
- Test automation frameworks (Selenium, Cypress, etc.)
- Performance and security testing
- Quality assurance processes`,
      
      'cybersecurity-analyst': `Review this resume for a Cybersecurity Analyst position. Focus on:
- Security assessment and vulnerability analysis
- Incident response and threat hunting
- Security tools and technologies
- Compliance and risk management
- Network and application security`,
      
      'cloud-engineer': `Review this resume for a Cloud Engineer position. Focus on:
- Cloud platform expertise (AWS, Azure, GCP)
- Infrastructure design and deployment
- Cloud security and compliance
- Cost optimization and resource management
- Multi-cloud and hybrid cloud solutions`,
      
      'blockchain-developer': `Review this resume for a Blockchain Developer position. Focus on:
- Blockchain platforms (Ethereum, Solana, etc.)
- Smart contract development
- Cryptography and security
- DeFi and Web3 technologies
- Distributed systems and consensus mechanisms`,
      
      'game-developer': `Review this resume for a Game Developer position. Focus on:
- Game engines (Unity, Unreal Engine)
- Programming languages (C++, C#, Python)
- Game design principles and mechanics
- Graphics programming and optimization
- Cross-platform game development`,
      
      'embedded-systems-engineer': `Review this resume for an Embedded Systems Engineer position. Focus on:
- Microcontroller programming (Arduino, Raspberry Pi)
- Real-time operating systems
- Hardware-software integration
- IoT and sensor technologies
- Low-level programming and optimization`
    };

    const rolePrompt = roleSpecificPrompts[jobRole] || roleSpecificPrompts['fullstack-developer'];
    
    const prompt = `Review the following resume for a ${jobRole.replace('-', ' ')} position and provide constructive feedback on its strengths, weaknesses, and areas for improvement.

${rolePrompt}

Resume Content:
${pdfData.text}

Please provide a comprehensive analysis including:
1. Overall assessment
2. Strengths
3. Areas for improvement
4. Specific recommendations for the target role
5. Skills and experience alignment with the job requirements`


    const response = await AI.chat.completions.create({
            model: "gemini-2.0-flash",
            messages: [{
                    role: "user",
                    content: prompt,
                },
            ],
            temperature: 0.7,
            max_tokens: 3000,
        });

        const content = response.choices[0].message.content

    await sql`INSERT INTO creations(user_id, prompt, content, type) VALUES (${userId}, ${`Review resume for ${jobRole.replace('-', ' ')} position`}, ${content}, 'resume-review')`;

    res.json({success: true, content: content})

  } catch (error) {
    console.log(error.message);
    res.json({success: false, message: error.message})
  }

}

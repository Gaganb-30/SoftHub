const uploadOnCloudinary = require("../config/cloudnary")
const App = require('../models/appModels')
const Category = require('../models/categoryModels');
const cleanUpLocalFiles = require('../utils/fileCleaner');

// Helper function to check download permission
const canDownload = (user, appId) => {
    if (!user) return false;
    return user.role === "ADMIN" ||
        user.purchasedGames.includes(appId.toString());
};

const calculateRelevanceScore = (app) => {
    // Weighted factors (adjust these as needed)
    const weights = {
        rating: 0.4,
        weeklyViews: 0.3,
        downloads: 0.2,
        recency: 0.1
    };

    // Calculate average rating
    const avgRating = app.reviews.length > 0
        ? app.reviews.reduce((sum, r) => sum + r.rating, 0) / app.reviews.length
        : 3; // Default to 3 if no reviews

    // Normalize values (0-1 range)
    const normalizedRating = avgRating / 5;
    const normalizedViews = Math.min(app.popularity.weeklyViews / 1000, 1);
    const normalizedDownloads = Math.min(app.popularity.totalDownloads / 500, 1);

    // Recency factor (more recent = higher score)
    const daysOld = (Date.now() - new Date(app.sortMetrics.releaseDate).getTime()) / (1000 * 60 * 60 * 24);
    const normalizedRecency = Math.max(0, 1 - (daysOld / 365)); // 1 = current, 0 = 1+ year old

    return (
        (weights.rating * normalizedRating) +
        (weights.weeklyViews * normalizedViews) +
        (weights.downloads * normalizedDownloads) +
        (weights.recency * normalizedRecency)
    );
};

// ---ADMIN PANEL--- Create apps
const createApp = async (req, res) => {
    const {
        title,
        description,
        platform,
        architecture,
        tags,
        isPaid,
        price,
        downloadLink,
        size,
        category,
        systemRequirements
    } = req.body;

    try {
        // Validate tags
        const tagsArray = tags ? tags.split(',') : [];
        if (tagsArray.length > 15) {
            return res.status(400).json({
                message: "Cannot have more than 15 tags",
                success: false
            });
        }

        // Category handling
        let categoryObj;
        if (category) {
            categoryObj = await Category.findOne({ name: category });
            if (!categoryObj) {
                categoryObj = new Category({ name: category });
                await categoryObj.save();
            }
        } else {
            return res.status(400).json({
                message: "Category is required",
                success: false
            });
        }

        // Upload thumbnails to Cloudinary
        const thumbnailUrls = [];
        if (req.files['thumbnail']) {
            for (const file of req.files['thumbnail']) {
                const thumbnailResult = await uploadOnCloudinary(file.path);
                if (thumbnailResult) {
                    thumbnailUrls.push(thumbnailResult.secure_url);
                } else {
                    return res.status(500).json({
                        error: 'Failed to upload thumbnail to Cloudinary',
                        success: false
                    });
                }
            }
        } else {
            return res.status(400).json({
                error: 'No thumbnails uploaded',
                success: false
            });
        }

        // Upload cover image if provided
        let coverImgUrl = "";
        if (req.files['coverImg'] && req.files['coverImg'][0]) {
            const coverImgResult = await uploadOnCloudinary(req.files['coverImg'][0].path);
            if (coverImgResult) {
                coverImgUrl = coverImgResult.secure_url;
            }
        }

        // Create new app with all fields
        const newApp = await App.create({
            title,
            description,
            platform,
            architecture: architecture || "Native",
            tags: tags ? tags.split(',') : [],
            isPaid,
            price,
            downloadLink,
            size,
            coverImg: coverImgUrl,
            thumbnail: thumbnailUrls,
            category: categoryObj._id,
            systemRequirements: systemRequirements ? JSON.parse(systemRequirements) : {}
        });

        res.status(201).json({
            newApp,
            success: true
        });

    } catch (error) {
        res.status(500).json({
            message: "Error in adding a new app: " + error.message,
            success: false
        });
    } finally {
        cleanUpLocalFiles("./uploads");
    }
}

// ---Get all Apps with Filtering and Sorting---
const getAllApps = async (req, res) => {
    const {
        page = 1,
        limit = 48,
        q = "",
        platform,
        architecture,
        tags,
        sortBy = 'popular'
    } = req.query;

    try {
        // Build query
        const query = {};
        if (q) query.title = { $regex: q, $options: 'i' };
        if (platform) query.platform = platform;
        if (architecture) query.architecture = architecture;
        if (tags) query.tags = { $all: tags.split(',') };

        // Build sort options
        let sort = {};
        switch (sortBy) {
            case 'popular':
                sort = { 'popularity.weeklyViews': -1 };
                break;
            case 'newest':
                sort = { 'sortMetrics.releaseDate': -1 };
                break;
            case 'oldest':
                sort = { 'sortMetrics.releaseDate': 1 };
                break;
            case 'sizeAsc':
                sort = { 'sortMetrics.sizeValue': 1 };
                break;
            case 'sizeDesc':
                sort = { 'sortMetrics.sizeValue': -1 };
                break;
            case 'relevance':
                sort = { 'sortMetrics.relevanceScore': -1 };
                break;
            default:
                sort = { createdAt: -1 };
        }

        // Execute query
        const apps = await App.find(query)
            .populate('category')
            .sort(sort)
            .skip((page - 1) * limit)
            .limit(Number(limit));

        const totalApps = await App.countDocuments(query);

        // Process apps to remove download links for unauthorized users
        const processedApps = apps.map(app => {
            const appData = app.toObject();

            if (appData.isPaid) {
                // Hide paid apps completely in public route OR hide downloadLink only
                delete appData.downloadLink;
            }

            return appData;
        });


        res.status(200).json({
            apps: processedApps,
            total: totalApps,
            success: true
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Error fetching apps: " + error.message,
            success: false
        });
    }
};

// ---Get apps by Category with Filtering---
const getAppsByCategory = async (req, res) => {
    const { categoryName } = req.params;
    const {
        page = 1,
        limit = 48,
        platform,
        architecture,
        tags,
        sizeRange, // NEW: size range filter
        sortBy = 'newest'
    } = req.query;

    try {
        const category = await Category.findOne({ name: categoryName });
        if (!category) {
            return res.status(404).json({
                message: "Category not found",
                success: false
            });
        }

        // Build query
        const query = { category: category._id };
        if (platform) query.platform = platform;
        if (architecture) query.architecture = architecture;
        if (tags) query.tags = { $all: tags.split(',') };

        // NEW: Size range filtering
        if (sizeRange) {
            const sizeInMB = {
                '5-10': [5 * 1024, 10 * 1024],
                '10-20': [10 * 1024, 20 * 1024],
                '20-40': [20 * 1024, 40 * 1024],
                '50-80': [50 * 1024, 80 * 1024],
                '80-100': [80 * 1024, 100 * 1024],
                '100-150': [100 * 1024, 150 * 1024],
                '150+': [150 * 1024, Infinity]
            };

            if (sizeInMB[sizeRange]) {
                query['sortMetrics.sizeValue'] = {
                    $gte: sizeInMB[sizeRange][0],
                    $lte: sizeInMB[sizeRange][1]
                };
            }
        }

        // Build sort options
        let sort = {};
        switch (sortBy) {
            case 'popular':
                sort = { 'popularity.weeklyViews': -1 };
                break;
            case 'relevance':
                // Calculate relevance for all apps first
                const allApps = await App.find(query).populate('category', 'name');
                const appsWithRelevance = allApps.map(app => ({
                    ...app.toObject(),
                    relevance: calculateRelevanceScore(app)
                }));

                // Sort by relevance and paginate manually
                const sortedApps = appsWithRelevance.sort((a, b) => b.relevance - a.relevance);
                const paginatedApps = sortedApps.slice((page - 1) * limit, page * limit);

                // Process apps to remove download links
                const processedPaginatedApps = paginatedApps.map(app => {
                    if (app.isPaid) {
                        if (!canDownload(req.user, app._id)) {
                            delete app.downloadLink;
                        }
                    }
                    return app;
                });

                return res.status(200).json({
                    apps: processedPaginatedApps,
                    total: sortedApps.length,
                    success: true
                });
            case 'newest':
                sort = { 'sortMetrics.releaseDate': -1 };
                break;
            case 'oldest':
                sort = { 'sortMetrics.releaseDate': 1 };
                break;
            case 'sizeAsc':
                sort = { 'sortMetrics.sizeValue': 1 };
                break;
            case 'sizeDesc':
                sort = { 'sortMetrics.sizeValue': -1 };
                break;
            default:
                sort = { createdAt: -1 };
        }

        // Execute query
        const apps = await App.find(query)
            .populate('category', 'name')
            .sort(sort)
            .skip((page - 1) * limit)
            .limit(Number(limit));

        const totalApps = await App.countDocuments(query);

        if (apps.length === 0) {
            return res.status(404).json({
                message: "No apps found for this category",
                success: false
            });
        }

        // Process apps to remove download links
        const processedApps = apps.map(app => {
            const appData = app.toObject();

            if (appData.isPaid) {
                // Hide paid apps completely in public route OR hide downloadLink only
                delete appData.downloadLink;
            }

            return appData;
        });


        res.status(200).json({
            apps: processedApps,
            total: totalApps,
            success: true
        });
    } catch (error) {
        res.status(500).json({
            message: "Error fetching apps by category: " + error.message,
            success: false
        });
    }
};

// ---ADMIN PANEL--- Update apps
const updateApp = async (req, res) => {
    const { id } = req.params;
    const {
        title,
        description,
        platform,
        architecture,
        tags,
        isPaid,
        price,
        downloadLink,
        size,
        category,
        systemRequirements
    } = req.body;

    try {
        // Prepare update data
        const updateData = {};

        // Basic fields
        if (title) updateData.title = title;
        if (description) updateData.description = description;
        if (platform) updateData.platform = platform;
        if (architecture) updateData.architecture = architecture;
        if (tags) updateData.tags = tags.split(',');
        if (isPaid !== undefined) updateData.isPaid = isPaid;
        if (price) updateData.price = price;
        if (downloadLink) updateData.downloadLink = downloadLink;
        if (size) updateData.size = size;
        if (systemRequirements) updateData.systemRequirements = JSON.parse(systemRequirements);

        // Handle category
        if (category) {
            const categoryObj = await Category.findOneAndUpdate(
                { name: category },
                { $setOnInsert: { name: category } },
                { upsert: true, new: true, runValidators: true }
            );
            updateData.category = categoryObj._id;
        }

        // Handle cover image update
        if (req.files['coverImg'] && req.files['coverImg'][0]) {
            const coverImgResult = await uploadOnCloudinary(req.files['coverImg'][0].path);
            if (coverImgResult) {
                updateData.coverImg = coverImgResult.secure_url;
            }
        }

        // Handle thumbnail updates
        if (req.files['thumbnail']) {
            const thumbnailUrls = [];
            for (const file of req.files['thumbnail']) {
                const thumbnailResult = await uploadOnCloudinary(file.path);
                if (thumbnailResult) {
                    thumbnailUrls.push(thumbnailResult.secure_url);
                }
            }
            updateData.thumbnail = thumbnailUrls;
        }

        // Update the app
        const updatedApp = await App.findByIdAndUpdate(id, updateData, {
            new: true,
            runValidators: true
        });

        if (!updatedApp) {
            return res.status(404).json({
                message: "App not found",
                success: false
            });
        }

        res.status(200).json({
            updatedApp,
            success: true
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Error updating app: " + error.message,
            success: false
        });
    } finally {
        cleanUpLocalFiles("./uploads");
    }
};

// --- Get app by ID with popularity tracking ---
const getAppById = async (req, res) => {
    const { id } = req.params;

    try {
        const app = await App.findById(id)
            .populate('category', 'name')
            .populate('reviews.userId', 'username avatar');

        if (!app) {
            return res.status(404).json({
                message: "App not found",
                success: false
            });
        }

        // Update popularity metrics
        const now = new Date();
        await App.findByIdAndUpdate(id, {
            $inc: {
                'popularity.dailyViews': 1,
                'popularity.weeklyViews': 1,
                'popularity.monthlyViews': 1
            },
            $set: { 'popularity.lastViewed': now }
        });

        // Convert to plain object and handle download link
        const appData = app.toObject();

        if (appData.isPaid) {
            delete appData.downloadLink;
        }


        res.status(200).json({
            app: appData,
            success: true
        });
    } catch (error) {
        res.status(500).json({
            message: "Error fetching app: " + error.message,
            success: false
        });
    }
};



const getPaidAppAccess = async (req, res) => {
    const { id } = req.params;
    const user = req.user;

    try {
        const app = await App.findById(id)
            .populate('category', 'name')
            .populate('reviews.userId', 'username avatar');

        if (!app) {
            return res.status(404).json({
                message: "App not found",
                success: false
            });
        }

        // Not a paid app? Send from public route instead
        if (!app.isPaid) {
            return res.status(400).json({
                message: "This app is free. Access it from the public route.",
                success: false
            });
        }

        const hasAccess = canDownload(user, app._id);
        if (!hasAccess) {
            return res.status(403).json({
                message: "You need to purchase this app to access it.",
                success: false
            });
        }

        res.status(200).json({
            app,
            success: true
        });

    } catch (error) {
        res.status(500).json({
            message: "Error accessing paid app: " + error.message,
            success: false
        });
    }
};



// --- Record a download ---
const recordDownload = async (req, res) => {
    const { id } = req.params;

    try {
        const updatedApp = await App.findByIdAndUpdate(
            id,
            { $inc: { 'popularity.totalDownloads': 1 } },
            { new: true }
        );

        if (!updatedApp) {
            return res.status(404).json({
                message: "App not found",
                success: false
            });
        }

        res.status(200).json({
            message: "Download recorded",
            totalDownloads: updatedApp.popularity.totalDownloads,
            success: true
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Error recording download: " + error.message,
            success: false
        });
    }
};

// ---ADMIN PANEL--- Delete App by id
const deleteApp = async (req, res) => {
    const { id } = req.params;

    try {
        const deletedApp = await App.findByIdAndDelete(id);
        if (!deletedApp) {
            return res.status(404).json({
                message: "App not found",
                success: false
            });
        }

        res.status(200).json({
            message: "App deleted successfully",
            success: true
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Error deleting app: " + error.message,
            success: false
        });
    }
};

module.exports = {
    createApp,
    getAllApps,
    getAppsByCategory,
    updateApp,
    getAppById,
    deleteApp,
    recordDownload,
    getPaidAppAccess
};
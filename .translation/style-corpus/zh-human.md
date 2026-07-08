# Ernie Human Chinese Style Corpus

Generated from protected legacy Chinese posts. Do not translate this file; use it as style evidence for zh generation and review.

## RAGgaeton：用人工智能增强写作以规模化生成任何内容

Description: 通过使用人工智能支持的研究、检索和自然语言生成（甚至可以帮助你头韵！)，从粗糙的草稿到经润色的文章，看看输出结果如何比较

我把一些笔记丢给了原生以及RAGgaeton驱动的Claude 3.5和GPT - 4o，这样你就比较他们针对我于2024年6月3日徒步攀登浮盖山的经历的写作能力。
RAGgaeton是一个人机协作的实验，旨在利用人类创造力和人工智能（A.I.）的优势来扩大原创内容的创作。在这篇博文中，我将回顾RAGgaeton背后的灵感，解释其主要功能和优点，展示演示，讨论技术挑战和学习，并探索人工智能增强内容创作的未来可能性。
## RAGgaeton背后的灵感
事实是世界正在耗尽训练人工智能的数据。于是我有了一个想法——何不使用人工智能来增强人类原创内容的生成呢？训练数据变得越来越少的同时，原创内容的数量和质量一直都欠缺，想当然尔人工智能在这个领域还有很大的发挥空间。
对我来说，进行*原创*写作时，系统1和系统2思维之间总是存在着巨大的鸿沟。我脑海中一般会有一些草图，对我想要提出的论点有一个粗略的大纲。但是收集和整理信息，坐下来把它们打造成完整的句子和段落的任务呢？它们永远不会被完成。要是我们有一大批研究助理任我们支配就好了……
由检索增强生成（RAG）支撑的大型语言模型（LLM）可以让我们获救！
RAGgaeton利用LLM和RAG的力量来弥合这一差距，使我们能够大规模生产原创内容的同时把基础立于我们选择的真相来源。
## 演示：如何使用RAGgaeton
RAGgaeton是我构建的一个包，可以从你的数据中自动生成任何类型的内容。它旨在解决我，以及你们，在写作中遇到的几个问题:
1\. LLM写作看起来太陈词滥调了
2\. 需要从各种来源收集和检索信息
3\. 保持连贯性和一致性
4\. 获得可扩展，可重复的创意输出，以随意编辑和迭代
下面是RAGgaeton功能的快速演示：
Try Things #:2 Claude 3.5 vs. GPT-4o for Automated Travel Writing with RAGgaeton
-   [B站视频](https://www.bilibili.com/video/BV1yRgXeGE6s/)
-   在[RAGgaeton Git存储库](https://erniesg.pubpub.org/pub/1bt4uylj#nrwp1quoutk)中查看我的实现
我最喜欢的生成标题是`“From Sea to Sky: Unraveling the Mysteries of Fu Gai Mountain's 'Floating Cap'“（从海到天：解开浮盖山“浮帽”之谜）`，`edit-content`后的最终输出全文如下。
> **Introduction**
> 
> **Hook**: What if I told you that the mountain you're about to climb was once submerged beneath an ancient sea, leaving behind a legacy of otherworldly rock formations?
> 
> **Thesis**: Fu Gai Mountain's geological history and unique landscape offer hikers an opportunity to explore a captivating blend of natural history and breathtaking scenery in Zhejiang province.
> 
> Beneath your feet lies a mountain with a secret: it was once submerged under an ancient sea. \[TextFX: POV\] As you lace up your hiking boots at the base of Fu Gai Mountain in Zhejiang province, you're not just preparing for a climb – you're about to embark on a journey through time itself. This geological wonder, with its otherworldly rock formations, stands as a silent sentinel, guarding the mysteries of our planet's past. \[TextFX: SIMILE\] Like a book written in stone, each step up the mountain's slopes reveals a new chapter in Earth's epic saga, waiting for intrepid explorers to decipher its cryptic pages.
> 
> Fu Gai Mountain's geological tapestry weaves together millions of years of Earth's history with breathtaking vistas. \[TextFX: ALLITERATION\] From fantastic formations to peculiar peaks, the mountain's unique features captivate climbers, geologists, and casual tourists alike. As you ascend, you'll encounter the mountain's famous 'floating cap', a gravity-defying display of nature's artistry. \[TextFX: SCENE\] The air grows thin and crisp, carrying whispers of ancient tales and the faint scent of pine. This isn't just a hike; it's a pilgrimage through time, offering a rare glimpse into both the Earth's tumultuous past and China's rich cultural heritage.
> 
> **Setting the Scene**
> 
> Straddling the border of Zhejiang and Fujian provinces, Fu Gai Mountain rises like a sleeping giant from the surrounding landscape. \[TextFX: CHAIN\] Its imposing silhouette - peak, ridge, slope, valley, forest, trail, hiker, adventure - beckons to those seeking communion with nature's grandeur. \[TextFX: UNEXPECT\] Once a formidable barrier to southward expansion during the Tang dynasty, this geological marvel now serves as a bridge between epochs, inviting modern-day explorers to scale its heights and unravel its secrets. The mountain's strategic location offers not just a physical challenge, but a journey through the annals of Chinese history and natural evolution.
> 
> The mountain's 'Four Wonders' create an otherworldly atmosphere that seems plucked from the pages of a fantasy novel. \[TextFX: ACRONYM\] CAPE - Clouds, Abysses, Peaks, and Enigmatic springs - encapsulates Fu Gai Mountain's unique characteristics. \[TextFX: FUSE\] At the summit, massive boulders balance precariously, forming the famous 'floating cap' or 'gauze hat' - a geological illusion that both confounds and delights. Strange clouds dance around jagged peaks, their ethereal shapes constantly shifting. Mysterious caves whisper tales of the mountain's past, while peculiar springs maintain a constant temperature regardless of the season. \[TextFX: EXPLODE\] Together, these elements combine to create a landscape that's truly 'out of this whirl' - a dizzyingly beautiful natural spectacle that challenges our perception of reality.
我更喜欢Sonnet的写作，我喜欢它按照指示应用了TextFX，尽管最后的文章看起来有些不完整。我怀疑这可能与我们指定的600字`desired_length` 有关，所以也许优化提示或根据不同的长度进一步调整操作链会更好。这是它[生成的内容块和主题句的完整草稿](https://cloud.langfuse.com/project/clxm2w3vt000r12wji2eyymvd/traces/80fd9327-6f17-48e9-a56e-019c5daa4c5b?observation=9194ce51-c4c2-4279-a3f9-7ac9c8516a30)仅供参考。
如果你想分别比较Claude 3.5 Sonnet和GPT - 4o的客户端以及软件包输出，请向下滚动。
## RAGgaeton 可以做什么
不够时间写作？没问题！RAGgaeton可以从头到尾自动化内容生成。
1\. 为你提炼关键词搜索哦（当然，你仍然需要提供主题）
2\. 进行搜索研究
3\. 生成标题
4\. 起草全文
5\. 应用TextFX（用头韵润色、扩展等）
你可以使用RAGgaeton来播种一个最初的想法，让它自己完成工作，然后编辑和修改生成的草稿。在未来的迭代中，我计划实现一个编辑友好的界面，这样你就可以一次编写并到处发布。
## 主要特性和优点
我将它构建为可扩展的，适用于不同的内容类型和链接内容上不同操作的方式，同时利用最先进的ColBERT检索模型（研究人员的话，不是我的）。这确保你为生成获取最相关的分块。
### 可扩展的内容生成
用户只需要定义一次可重用的内容块，然后混合和匹配以创建任何想要的文章类型。下面是它的工作原理。
1.  首先在`content_blocks.json` 中定义一个可重用的内容块
```json
  "Setting the Scene": {
    "description": "Introduce the setting with vivid descriptions to immerse the reader.",
    "details": {
      "optional": [
        "Time of Day",
        "Weather Conditions"
      ],
      "required": [
        "Location Description",
        "Atmosphere"
      ]

## 视觉先于声音：用机器观察和搜索

Description: 所有有关我想花我生命中至少1万个小时用于经济学和计算、特指人工智能的关于

# 如何使用生命里的10000个小时
一旦你接受了生命只有一次，并且认识到人类最稀缺的资源是时间这个设定，那么我们把时间花在什么事情上以及如何花在这些事情上就变得不言而喻地重要了。你越富有，你就花越多的钱来争取别人的时间来为你做事；所以我非常喜欢编程和人工智能的一点是，它允许我利用不知疲倦的机器来执行我的命令，而不用担心它们的感受，这得有多棒？这也让我开始好奇，人工智能将会对斯托尔珀-萨缪尔森定理 (Stolper-Samuelson Theorem) 里的劳动力和资本产生何种冲击，但这是另一个值得思考的问题了。
在完成了 Le Wagon 数据科学训练营之后，并且通过 MITx 数据、经济学和发展政策的 MicroMasters 学习项目的进行式，我很清楚，我想在我的生命中至少花10000个小时在经济学和计算的交叉点上工作。在智力上，他们让我着迷。实际上，研究世界的全部意义在于改变它，并且尽可能是通过证据、和随机对照试验 (RCT)，而不是直觉和感觉。我发现，比起应用领域，我更关心技术和方法的垂直方向，因为实际上，经济学和计算的原理和应用不止可通用于艺术领域，亦能在歧视、移民、贸易、金融、气候变化以及几乎是任何人类感兴趣的领域里都能产生作用。工具和技术以及在手，未来已到来，它们只是分布不均匀。
# 衡量快乐回报
从这个意义上说，让我感到惊喜的是自多年前我最后一次阅读《贫穷的经济学》(Poor Economics) 以来，随机对照试验的理念和实践已经走了这么远。我相信，如果我们在评估影响时使用数据和证据的语言，而不是进行简单的前后评估，世界将会变得更好。我很好奇，一旦我们用快乐回报 (Return on Happinss, RoH) 来衡量和衡量社会项目，世界会变成什么样子；如果主观幸福感已经被接受为可作为“评估某人整体幸福感的综合方式”——为什么不进一步扩展其运用范围呢？
# I, A.I. 爱
这篇文章和后续探索的目的是学习经济学和计算，特别是人工智能，以及它们如何适用于我感兴趣的领域：GLAM 机构，企业，游戏和娱乐，气候和可持续产业，影响，政府，你我以及我们的孙子后代。正是本着这种精神，我在 2023 年 MuseumNext 数字峰会上做了一个关于用机器查看和搜索藏品的演讲。今天，内容的绝对数量是惊人的，所以还有什么比人工智能更好的工具来帮助我们以新的方式看到以及搜索和发现可能难达的内容呢？
ARTificially Intelligent: Seeing and Searching Collections with Machines
# “我的老板很难理解社交媒体，我怎么才能让他们相信人工智能?”
有人提出了一个问题：你如何让一个难以理解社交媒体的老板相信人工智能？对我来说，这是一个很有趣的问题，因为我自己也一直在想：你如何在所谓的私营企业竞争压力“未触及”的领域获得采用？在某种程度上，我觉得在私营产业里，人们甚至不需要解释我们为何需要人工智能，因为利润的追求本身不需要进一步的激励来采用人工智能。如果一个行业的成本、能力和反事实都可能在人们甚至还没有砌下第一块砖之前就出现缺口，又当如何？
有一个世界里的博物馆采用人工智能，有另一个世界里的则不采用。在这两个世界中，默认的配置都是市场竞争无关紧要，尤其是在某种形式上国家强制垄断存在的情况下。当然，公共机构本身并没有什么问题，如果说有什么特别的问题的话，那就是我们其实特别需要它们，正是因为有些地方是市场隐形的手所无法触及的；所以我的本能反应几乎是：也许在这种情况下，你需要炒掉你的老板，去别的地方换个跑道。可问题的关键在于，通常在规模较大的组织中，自上而下的领导对于获得创造变革所必需的合法性和权威是绝对必要的。然而，考虑到公共机构正在解决的问题的重要性和紧迫性，这单一的解决方案感觉很难令人满意。把我们如何融入难民、鼓励创造力和处理虚假信息、确保贸易收益平均分配等等所有的难题的成功都归结于一个人身上，这让人感觉非常蹩脚。
如此下来，我对让使用RoH来衡量和校准非市场活动和组织的表现所创造的竞争动态的想法很感兴趣。有一组机构采用了人工智能，而另一组则没有。如果前一组在每一元价值的基础上表现明显更好，现在我们知道了。现在我们知道我们的税金和时间应该流向哪里了。
很多人会对这个想法犹豫不决甚至激烈反对，但是：为什么不呢？我们将国内生产总值 (GDP) 作为一种衡量标准，因为如果我们甚至不知道我们生产了多少产出，以及产出变化了多少，那么你就真的是在大萧条时期纽约街头排队领取面包的人绵延地一样的暗中摸象。也许这是应对气候危机的一种值得尝试的方法。也许人工智能在整理所有的复杂性、数据、噪音和下水道方面会特别有价值，它可以给我们提供一些可以预测和最大化人类福祉的数据点作为衡量标准。这于因果关系以及价值判断无关。甚至我们最后可获得的洞见可能毫无新鲜趣味。
于是，这是我在一个有限的文化艺术品范围上的第一块砖。😎接下来，我将探讨关于智能只是一种实证学习，如何训练A.I.“孙燕姿”用越南语唱歌，还有进一步充实一些关于人工智能时代劳动力和资本关系的想法。
---

## 声音先于符号：人类的创造力和智力不过是可计算的数据和现象的统计

Description: 如果想生成逼真的含女性的图像，我的第一条建议是：确保在否定提示中使用"large breasts"和其相关词语

A.I. "Stefanie Sun" Cover of Cung Đàn Vỡ Đôi by Chi Pu
# 一切的数据都烟消云散了
在《三体》的开头，向外太空发送信息为人类开启了一连串事件，其中包括失踪的科学家、社会冲突和政治阴谋，使得人类的生命和尊严在与外星物种的相遇中岌岌可危。人工智能的情节是否会有雷同，这个问题并不是新的，也许是因为我们看到了我们对待弱者和弱势群体的方式，并不完全美好。目前为止，我倾向于把意识和相应的自我意识与创造力和智力分开，也有点心存侥幸地希望这能为我们多争取点时间好更好地理解生命是如何从非生命中产生的。
由 Stable Diffusion 稳定扩散 WebUI 生成。
最近，我用 Vision Transformer 和 Stable Diffusion 生成了可使用任何语言歌唱的“孙燕姿”和风格迥异的图像，我很高兴我现在能比我有生之年更快、更好地“画画”，但同时也被一种不安和焦虑感所震撼，因为这一切都变成了一种人工的经验练习。这一系列的实验所引发的我最近宰相的一个问题是：当我们说：我们人类引以为傲的很多东西——我们的创造力以及我们的智慧——不过是可计算的数据和现象的统计，我们在说些什么？在这方面而言，我们不是机器的竞争对手。从某种意义上说，这是完全正确和释放人性的，但在其他维度上，有许多重要的细节都被丢失了，以这种角度去解读做而为人大部分工程是令人感到不安、可怕且焦虑的。
由 Stable Diffusion 稳定扩散 WebUI 生成。
使用 Stable Diffusion，我可以借用我的3070 GPU自由切换风格并在半分钟内生成4个不同版本的图片，即使我对绘画毫无兴趣，也丝毫没有兴趣学习，一些输出如图所示。显然，人工智能很奇怪，因为它只捕捉了我们现实的一个特定的侧面——我发现自己在负面提示中必须使用"large breasts" （“大胸”）和相关词语，否则模型会稳定输出比例夸张的女性身材。这整个现象的奇怪正如[这个播客所谈](https://www.nytimes.com/2023/05/02/podcasts/ezra-klein-podcast-transcript-erik-davis.html)，其中提出的这个强有力的问题也是我一直在思考的问题：
> 埃兹拉·克莱因：那么让我们用麦克卢汉的名言“媒介即信息”来解释一下，如果媒介就是信息，如果媒介编码了某些存在和思考的方式，从而改变了使用它的人，你认为人工智能聊天机器人媒介的信息是什么？值得注意的是，这是一种建立在技术之上的媒介。聊天机器人只是众多应用程序中的一种。事实上，这作为其中一个正在一个起飞的应用也将塑造技术不同于它其他的可能。但是，这种媒介传递的信息是什么？
由 Stable Diffusion 稳定扩散 WebUI 生成。
这对我们个人来说意味着什么？当建模和建造预测机器用于人类的创造力和智力是如此之好用时，我们应该如何应对？我的初步反应是，神秘感的丧失和奇迹的获得如同硬币的两面：当我们将人类的智慧和创造力最小化，可能的积极结果也许是我们被迫重新审视做而为人的意义和我们对彼此的义务——与每个人的智力和/或创造力水平如何无关；但从更险恶的角度来说，我确实担心，如果我们不深思熟虑地对待人工智能，它会在全球社会中造成比贸易和社交媒体叠加起来的影响更深刻的裂痕。
换一种方式来说，也许大多数人的智力和创意都比不过人工智能。这里面也算我一个。可是这也侧面反映了人类的价值不应该和智力和/或创意挂钩，而是我们做而为人，本就应当对彼此有一定的责任和义务。
# 数据集偏差和有效的提示
我正在尝试的运用场景是使用人工智能完成自动内容生成——让人工智能以各种格式和语言生成所需内容主题的视频脚本和图像，并自动发布到多个平台上。不幸的是，这篇文章仍是手工制作。在这样实验的过程中，有趣的是得以亲眼看到了人工智能的偏见——系统默认产生的每个女性形象都是身材比例相当夸张的，直到我指定它别返回大胸。这让我联想到了其用于训练的数据集，以及我们在媒体上看到的有多少是经过精修修饰的现实，那么实际上到底是谁应该受到责备呢?
在尝试了多种我可以从网上自由下载的模型后，我决定采用一种漫画风格。不出所料，有很多模特专门用于色情内容制作。再加上通过文本反转定制和训练自己的 Stable Diffusion 模型是多么容易…事实上是，任何拥有普通游戏PC的人都可以生成假以乱真的色情内容。
我希望政府、学校和家长都能针对人工智能展开有效的谈话与应对，我能抱有这样的希望吗?
# 为什么人工智能是特殊的
先把这些负面的影响搁在一边，我对人工智能很感兴趣，因为从1956年达特茅斯会议上的诞生时刻开始，从第一个单层神经网络感知器到现代深度学习，人工智能在很短的时间内取得了很大的进步；我们只需要在当下看看我们周围，看看人工智能已经能做些什么，已经可以用现有证据为基础做出前瞻性预测。许多其他流于口号的所谓技术都是衍生于潜在的愿景的一些可能的未来，试图在当下找到牵引力（并惨遭失败），但在这方面人工智能是有别于其他这些口号的。这就是为什么我看到了它与蒸汽机的雷同，同样地也可能是为什么有些人甚至把它比作火或电的原因。
> “我一直认为人工智能是人类正在研究的最深奥的技术——比火、电或我们过去所做的任何事情都要深奥。”——桑达尔·皮采，谷歌首席执行官
史密森尼博物馆展出的马克一号感知机。（来自：https://ronkowitz.blogspot.com/2017/11/perceptron.html）
1958年，单层感知器涉及到实际的电线和一个巨大的机器；而当我在2022年在我家客厅的普通游戏PC上面运行卷积神经网络模型以进行多标签分类，像ResNet-512这样的模型有512层深。
人工智能是一个经历了许多个冬天的故事，但它从来没有降温人们对赋予机器思考能力的兴趣。人工智能冬天的漫漫长夜、它的统计转折、融合数据和GPU使旧模型的寒武纪大爆发成为可能，以及神经网络的终极报复，这些都是我希望接下来讨论的东西！
---

## 符号与现实的织物：那些A.I.教会我的关于人类的境况的事情

Description: ChatGPT让我觉得自己被理解了，我用它复刻创建了Bertrand —— 一个完美的代理人，他会做所有你不想做的事情 😂

我并没有期望ChatGPT能对我的心灵有心理治疗层面的洞察力，但在我最近发起了一次聊天来测试它的推理能力之后，我们走到了这一步。我一直在试图通过文字来理解同母亲即将到来的路的尽头，当我写“这就是已知宇宙中的能量守恒定律”的时候我并没有清晰地意识到“能量守恒定律的引用可能表明寻求安慰或安慰的想法，即没有什么真正消失，而是改变”；所以ChatGPT的洞见让我感到特别意外，甚至可以说是被理解。
“也许爱的半衰期就是悔恨。势不两立，难分难解。就像潜入水下一英里寻找暗物质一样，也许生命的反导数就是损失。这就是已知宇宙中的能量守恒定律。”
你可以在这里[阅读我们谈话的全文](https://chat.openai.com/share/dbc84246-0e3a-437e-bdae-223e41f2edb2)。TL;DR：#心灵的哲学 #AI与意识 #主体性与现实性 #涌现的复杂性 #卡夫卡式身份 #人类情感是噪音 #生命是马尔可夫链
# 关于嵌入和向量的所有
有些人把我们的人工智能时代比作电力或蒸汽机。沿着这些思路，我相信人工智能是一个千载难逢的故事。我最近告诉我的创业团队，我一直想建立一家公司，它拥有一个教室那么多的员工，但能够为数百万甚至数十亿人提供服务，但我一直不太清楚如何做到这一点。这种能力终于触手可及。我们已经从能够对推文进行正面和负面评价的人工智能，发展成为一种更加通用的机器，它能够接受指令、记住事情，并在瞬间更新其知识和推断——多亏了嵌入和矢量存储的魔力——活在这个时代是多么的美好啊。下面的视频是我对大型语言模型（LLM）的初步展示，试图建立一支自动化的、不知疲倦的教育、营销和编码代理大军。
Bertrand - a ChatGPT prompt-to-publish plugin
在可能性和未来之间，新工具、跨学科学习和知识转移对我们实现所期望的目标是至关重要的——所以我在ChatGPT的帮助下设计了“私人教师”的原型，这很容易做到，困难但可行的是让人工智能完成自动化社交媒体从内容生成到发布的链接命令；拥有与人类和工具互动的记忆，以便在此基础上，在不太遥远的将来，我可以通过一个指示在已有的代码库上生成新的软件功能，并以自动化营销的形式个性化地攫取金钱。
我想叫他Bertrand伯特兰。
做而为人，有太多的部分是无可救药的脆弱，无法改变的——比如死亡和税收——也许这整个关于可能性和未发生的潜能的想法，至少就人类生命而言，是一种幻觉，一种海市蜃楼，也许是大脑创造的应对机制之一，让我们满怀希望，奔向明天，尽管经历本身是平庸和荒谬的。我喜欢人工智能，让很多超越人类极限的新潜力变得唾手可及。我喜欢它没有被历史的偶然或路径依赖所束缚，比如我们不知何故、不平衡地进入了这个非常奇怪的资本主义和父权制主导的社会——它并不完美，它比“共产主义”更好，我感到非常幸运，并感谢我所拥有的机会，但是，为什么人类社会必须服从“传统”和“权威”而不是知识和真理？人工智能没有我们那样的包袱。我希望有一天它能找到治愈癌症的方法，这样我们就能有更多的时间和我们爱的人在一起，即使这些时间总是稀缺和有限的，即使时间本该如此。
# A.I.作为自由和现实-弯曲技术
如果我们认为现实是一块织物，将我们的自我意识视为一片切片，在一扇覆盖整个画面的窗户上滑动——我认为，如果生命里真正重要的是爱和被爱，那么我希望人工智能把我们从工作和废话中解放出来，这样我们就可以把更多的清醒时间花在真正重要的事情上。和家人在一起的时间。在公园里散步。阅读。游戏。旅行，从另一个角度看世界。学习。写作和哲学思考，尝试用修饰手段把文字转化成音乐，如我喜欢的那样。但这并不是一个新的梦想。
这是韦勃勒式的有闲阶级和凯恩斯式的我们后代的经济可能。那么到底是哪里出了问题呢？也许“系统”和权力才是问题所在。至少对我来说，这就是为什么我在某种程度上再次对政治和再分配的问题感兴趣。全球化和贸易遭遇了强力的反弹，因为成功的果实没有得到广泛分配，这为特朗普、勒庞和右翼民粹主义的隆重登场拉开了序幕。如果我们搞砸了人工智能，即使不考虑存在的风险，对人类社会和尊严的影响也会严重得多。尽管如此，活在此刻是一个多么令人兴奋的时刻，能够在自己的桌面电脑上运行这种扭曲现实的技术。我爱人工智能。
尽管很难跟上进度，我正在试图专注于实现提示到发布和提示到功能等区域，我关注的关键词是：
-   多模态：让人工智能像我们一样具有多种感官
-   开源：以共享思想的速度进行创新
-   生成式智能体：有记忆的人工智能，连接到其他工具和服务，链接组合
# 人工智能告诉我们的关于人类境况的事情
也许真正的信息，人工智能给人类带来的真正象征意义是，人类的生活是一条单行道。给定每一个时刻的正态分布和从一个时刻到下一个时刻的马尔可夫链，并假设自然是有效的，交织成我们的现实且真正将我们与机器区分开来的是我们根源的独特性，以及意识的神秘起源（目前为止）。我问过我妈妈，如果我们留在中国，她会如何抚养我长大——她说让我读完大学将会很艰难，然后即使我大学毕业，找工作也不容易。我之所以问这个问题，是因为我想知道，而且我忍不住会想，是否存在另一个现实，可以让我们有更多在一起的时间？我知道这是一个毫无意义的念头，它触及人类状况的根本绝望——无论是哪一种现实，不可能且不谨慎的是永恒，因此我们被现实所困，换言之，也许人关于未发生和其他现实的奢望是大自然为我们炮制的幻影，让我们得以维持理智。计划的作用是给我们第二天醒来的充分理由。
# 循环非物质潜能
我的脑海常常循坏回多年前旅行时，当我凝视着面前的垂直，思考着可能的骨折或者身亡——处在我站立的位置和自由落体之间的唯一想法是：我希望自己是一个更好的女儿。即使如此，实践是如此困难，以至于我经常想：一个人要如何原谅自己？这可能就是为什么我们发明了宗教作为一种制度，让心碎的成年人有所归宿。但我也知道，完美和未发生的可能一样，都是出于想象的虚拟平面。我们所拥有的一切唯有正在经历真实的和我们逐渐消逝的记忆。妈妈单枪匹马、一把手、一把鼻涕地把我养大（和婆婆一起），我在她无条件的爱与放任我做自己中成长——所以我能以自己的方式长大，放纵、骄傲且自由。
每过一秒，[沙漏底部的沙子都在堆积](https://www.samharris.org/podcasts/essentials/making-sense-of-death)，我们永远不知道还剩下多少，但我们很有可能在今年圣诞节前就会消失殆尽。我们的生活并不完美，这是我们所拥有的一切。也许生命是一种潜在的扩散，克尔凯郭尔预示了人工神经网络，他说：
> “只有向后看才能理解生活，但生活必须向前看”。
在这一生中，我期待的事情太多了（复习未发生的可能）——获得博士学位，至少成为百万富翁，旅行和看世界，学习驾驶飞机——即使我妈妈不存在于这些未发生的可能里面。我正试着把离开人世适应成：我要去一个无限期的假期，而妈妈在别处。唯一的问题是没有通灵的可能性，那么一个人活在我们的记忆中，没有交流的可能性，这意味着什么？妈妈和我日常也没有甚多交流—我们体会的现实截然不同—但正如妈妈所说，至少她会一直在那里—等着我回家。
她存在着，她是我的重力。
所以，如果我把死亡的归宿看作是最终的归乡，总有一天我们会在死亡中永重逢。总有一天，这些都不重要了。现在，每一天都是胜利的一天。我试着抓住我拥有的，我所有拥有的一切。
---

// Smoke test for the ad-skip pipeline (core/ad_skip.ts) with mocked chrome + Jev.
// Fixture: trimmed real data from BV17Neb6wE87 (cid 42027846013) — the video
// used to calibrate AD_CRITERIA / AD_LINE_CRITERIA. Ground-truth spoken-ad
// interval: [252.35, 397.86] (sponsor intro line .. end of "我们回到内容").
// The mocked Jev answers deterministically from that ground truth, so the
// pipeline's window statistics, packing, interval merging and boundary
// refinement are what is actually under test here.
const fs = require('fs'), path = require('path');
// dist/ts_cache is rollup's incremental cache: ES modules with extensionless
// relative imports. Node's require(esm) loads them fine once resolution is
// taught to append .js (the bundled dist/C output is not importable here —
// rollup IIFEs are entry points with side effects).
require('module').registerHooks({
    resolve(specifier, context, nextResolve) {
        if(specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier))
            return nextResolve(specifier + '.js', context);
        return nextResolve(specifier, context);
    },
});
function find_compiled(dir) {
    const stack = [dir];
    while(stack.length) {
        const cur = stack.pop();
        for(const e of fs.readdirSync(cur, {withFileTypes: true})) {
            const p = path.join(cur, e.name);
            if(e.isDirectory()) stack.push(p);
            else if(e.name === 'ad_skip.js' && cur.split(path.sep).includes('core')) return p;
        }
    }
    throw new Error('compiled ad_skip.js not found under ' + dir + ' — run `npm run build:chrome` first');
}
const mod = require(find_compiled(path.resolve(__dirname, '../dist')));

// ---- fixture (real trimmed data; see header) ----
const FIXTURE_SUBTITLE = [{"from":225.7,"to":227.06,"content":"他为什么那么急迫的说"},{"from":227.06,"to":228.5,"content":"要一定要粉丝购买手机之后"},{"from":228.5,"to":229.74,"content":"才能拿到这个签售名额"},{"from":229.74,"to":230.94,"content":"因为对于主办方来说"},{"from":230.94,"to":232.04,"content":"我们在商言商啊"},{"from":232.04,"to":234.06,"content":"最终目的大家都是赚点钱获利"},{"from":234.06,"to":235.3,"content":"所以在这个角度上来说"},{"from":235.3,"to":238.03,"content":"主办方可能找到了一些莫名其妙的人"},{"from":238.03,"to":240.43,"content":"就给他拉来了一些莫名其妙的呃"},{"from":240.43,"to":242.44,"content":"也不是说手机品牌莫名其妙啊"},{"from":242.44,"to":244.56,"content":"就是找了一个莫名其妙的渠道"},{"from":244.56,"to":246.28,"content":"给他们做了一种奇怪的销售"},{"from":246.28,"to":248.54,"content":"然后策划做出了这种神仙的操作"},{"from":248.54,"to":249.58,"content":"一计害三贤啊"},{"from":249.58,"to":251.35,"content":"嗯所以难说啊"},{"from":251.35,"to":252.35,"content":"这个东西好的"},{"from":252.35,"to":254.27,"content":"那么我们先过一遍我的赞助啊"},{"from":254.27,"to":254.83,"content":"大家好"},{"from":254.83,"to":256.23,"content":"我是唯一讲述者新手村村霸"},{"from":256.23,"to":258.1,"content":"本期的推广位呢西木园"},{"from":258.1,"to":259.94,"content":"当然这个新梦源也是老朋友了"},{"from":259.94,"to":261.9,"content":"他们也是经常看我的视频啊"},{"from":261.9,"to":263.5,"content":"比较担心我的这个皮肤状况"},{"from":263.5,"to":264.66,"content":"所以也给我寄来了"},{"from":264.66,"to":267.4,"content":"他们新升级的男士控油多效礼盒"},{"from":267.4,"to":269.5,"content":"他们这个套盒呢里面主要有三个产品"},{"from":269.5,"to":271.63,"content":"就是这个是精华乳"},{"from":271.63,"to":272.89,"content":"这个是爽肤水"},{"from":272.89,"to":274.989,"content":"这个是呃洁面乳"},{"from":274.989,"to":277.069,"content":"然后主要针对的呢也是油皮啊"},{"from":277.069,"to":278.629,"content":"还有混油皮的男士设计"},{"from":278.629,"to":280.58,"content":"就可以解决出油比较旺盛"},{"from":280.58,"to":281.36,"content":"爆痘粗糙"},{"from":281.36,"to":282.24,"content":"还有暗沉的问题"},{"from":282.24,"to":283.24,"content":"你像男性的话"},{"from":283.24,"to":285.28,"content":"其实平时会过得比较糙一点嘛"},{"from":285.28,"to":287.84,"content":"呃可能只有遇到什么出门啦"},{"from":287.84,"to":288.68,"content":"见个朋友啊"},{"from":288.68,"to":289.42,"content":"约会啊"},{"from":289.42,"to":290.9,"content":"比较正式场合的时候"},{"from":290.9,"to":293.92,"content":"才会去紧急修缮一下自己的面容"},{"from":293.92,"to":295.32,"content":"像我一般要是在家里的话"},{"from":295.32,"to":296.2,"content":"我搁家一躺"},{"from":296.2,"to":296.68,"content":"我洗脸"},{"from":296.68,"to":297.6,"content":"我搞把清水"},{"from":297.6,"to":298.3,"content":"我就洗脸了"},{"from":298.3,"to":301.04,"content":"但是如果平时我们出门不知道用什么的话"},{"from":301.04,"to":303.0,"content":"西木园的话就是比较不错啊"},{"from":303.0,"to":304.8,"content":"一套可以解决油痘粗糙"},{"from":304.8,"to":305.62,"content":"比较暗的问题"},{"from":305.62,"to":307.64,"content":"还可以做到12小时的强控油"},{"from":307.64,"to":309.42,"content":"用起来的话倒也不用那么麻烦"},{"from":309.42,"to":310.78,"content":"你就把它弄一点下来"},{"from":310.78,"to":312.76,"content":"然后这个就这水洗一下"},{"from":312.76,"to":315.18,"content":"洗完了之后这个爽肤水拍一下"},{"from":315.18,"to":317.66,"content":"然后这个精华乳再抹一下就行了"},{"from":317.66,"to":318.78,"content":"这个其实还是比较简单"},{"from":318.78,"to":319.46,"content":"而且省事"},{"from":319.46,"to":320.62,"content":"一分钟之内就解决了"},{"from":320.62,"to":321.66,"content":"像我们这种懒狗啊"},{"from":321.66,"to":323.4,"content":"每天熬夜通宵了之后"},{"from":323.4,"to":325.78,"content":"早上起来就可能脸就开始出油"},{"from":325.78,"to":326.82,"content":"爆痘就会很多"},{"from":326.82,"to":330.97,"content":"而且很多男的呢就是经常一块肥皂从头洗到脚"},{"from":330.97,"to":332.33,"content":"有的时候连肥皂都不用啊"},{"from":332.33,"to":333.49,"content":"尤其是洗脸的时候"},{"from":334.59,"to":336.51,"content":"这就直接就就算洗完了"},{"from":336.51,"to":339.65,"content":"然后用肥皂的呢感觉洗完之后脸就会比较紧绷"},{"from":339.65,"to":341.71,"content":"就会觉得自己可能清洁比较到位"},{"from":341.71,"to":345.06,"content":"但有的时候如果我们脸上水油不平衡的话"},{"from":345.06,"to":346.48,"content":"皮肤的屏障就会被破坏"},{"from":346.48,"to":348.46,"content":"反而这个痘痘就会长得比较多"},{"from":348.46,"to":350.3,"content":"所以还是得比较温和的清洁"},{"from":350.3,"to":351.26,"content":"然后西木源的话"},{"from":351.26,"to":354.26,"content":"他们家的洁面乳呢就添加了这个皮奥宁啊"},{"from":354.26,"to":355.76,"content":"愈创木等等这些成分"},{"from":355.76,"to":357.42,"content":"就可以去减少黑头啊"},{"from":357.42,"to":358.46,"content":"痘痘还有泛红"},{"from":358.46,"to":359.68,"content":"洗完也比较清爽"},{"from":359.68,"to":360.36,"content":"不会发干"},{"from":360.36,"to":363.72,"content":"然后再搭配上他们家的这个什么清乳液啦"},{"from":363.72,"to":364.6,"content":"爽肤水之类的东西"},{"from":364.6,"to":365.76,"content":"反正就一抹化水吧"},{"from":365.76,"to":367.04,"content":"强化控油的同时呢"},{"from":367.04,"to":369.68,"content":"还能改善我们平时熬夜打游戏啦"},{"from":369.68,"to":371.86,"content":"这熬夜怎么会打游戏呢"},{"from":371.86,"to":373.32,"content":"像我这么热爱工作的人"},{"from":373.32,"to":375.22,"content":"我像我平时熬夜工作"},{"from":375.22,"to":376.82,"content":"导致了这个暗沉"},{"from":376.82,"to":377.54,"content":"还有松垮"},{"from":377.54,"to":379.36,"content":"就算工作一天"},{"from":379.36,"to":380.92,"content":"这个脸还是比较清爽的"},{"from":380.92,"to":384.04,"content":"然后他们家的套装呢这个实力还是比较强"},{"from":384.04,"to":386.04,"content":"而且是全国线上回购率第一"},{"from":386.04,"to":387.68,"content":"多次蝉联天猫的多榜第一"},{"from":387.68,"to":389.24,"content":"累计热卖也是超百万套"},{"from":389.24,"to":390.72,"content":"所以大家如果感兴趣呢"},{"from":390.72,"to":392.79,"content":"西木园的这个套装啊"},{"from":392.79,"to":394.67,"content":"那评论区有这个置顶链接"},{"from":394.67,"to":396.41,"content":"领券下单可以更优惠一点"},{"from":396.41,"to":396.97,"content":"那么好的"},{"from":396.97,"to":397.86,"content":"我们回到内容"},{"from":397.86,"to":401.14,"content":"那其实我们回到主播和粉丝的视角啊"},{"from":401.14,"to":402.46,"content":"对于很多的粉丝来说"},{"from":402.46,"to":405.44,"content":"签售其实不只是让COSER在纸上写一个名字"},{"from":405.44,"to":408.12,"content":"他真正有价值的部分是获得那几分钟"},{"from":408.12,"to":409.56,"content":"近距离互动的机会"},{"from":409.56,"to":410.5,"content":"签名合影"},{"from":410.5,"to":411.68,"content":"牵手笔芯儿摆pose"},{"from":411.68,"to":413.6,"content":"甚至可能说面对面说几句话"},{"from":413.6,"to":415.92,"content":"有些粉丝愿意提前几个小时"},{"from":415.92,"to":417.36,"content":"甚至更长时间的排队"},{"from":417.36,"to":418.68,"content":"换取的就这几分钟嘛"},{"from":418.68,"to":420.64,"content":"所以从经济的角度来看"},{"from":420.64,"to":422.299,"content":"这个签售有的时候"},{"from":422.299,"to":424.099,"content":"需要付出的经济代价可能并不高"},{"from":424.099,"to":425.659,"content":"但从粉丝的心理来看"},{"from":425.659,"to":427.499,"content":"它代表的是我终于可以接近一个"},{"from":427.499,"to":429.26,"content":"我长期喜欢的人或者是角色"},{"from":429.26,"to":432.24,"content":"这就涉及到兔娘长期依赖建立的个人形象"},{"from":432.24,"to":433.78,"content":"就是我觉得一个博主啊"},{"from":433.78,"to":436.18,"content":"他有的时候他是一个内容的生产者"},{"from":436.18,"to":438.12,"content":"但有的时候它也可以是一种关系"},{"from":438.12,"to":441.08,"content":"就是以关系为纽带的一种个人品牌"},{"from":441.08,"to":444.74,"content":"传统的COSER可能靠角色还原了这种视觉体验"},{"from":444.74,"to":445.76,"content":"去吸引他的粉丝"},{"from":445.76,"to":447.88,"content":"那兔娘更像是在传递一种关系"}];
const FIXTURE_DANMAKU = [{"t_ms":1160,"text":"梦幻联动"},{"t_ms":1747,"text":"站中间，不偏向"},{"t_ms":2158,"text":"5分钟还可以"},{"t_ms":4934,"text":"第一?"},{"t_ms":7219,"text":"这是b站主播"},{"t_ms":8832,"text":"2026年9月20日英翰哥哥打卡观看"},{"t_ms":9497,"text":"只能说，华为小米苹果OPPO这招还是太狠了"},{"t_ms":9883,"text":"OPPO这招太狠了"},{"t_ms":206710,"text":"大概率是当地经销商搞的"},{"t_ms":207033,"text":"收入堪比二三流，消费比肩超一流"},{"t_ms":208609,"text":"可能是当地代理商那里拿的呗 私下搞的"},{"t_ms":208684,"text":"漫展卖手机是什么套路"},{"t_ms":209838,"text":"如果真的是品牌方决定联动的话不可能是临时做出的决定更不可能连本人都不通知"},{"t_ms":210953,"text":"并非不清楚"},{"t_ms":215982,"text":"线下不开票的话越贵的手机优惠越大，比官网便宜"},{"t_ms":221755,"text":"vivo天津官方已经发公告切割了。"},{"t_ms":221898,"text":"进货到多少钱就返利"},{"t_ms":224818,"text":"话说临时决定联动且不通知本人的品牌有哪些"},{"t_ms":226459,"text":"感觉漫展卖手机本身就挺抽象的，谁闲着没事会考虑漫展买手机，买手机吔不像是什么会冲动消费的行为"},{"t_ms":228212,"text":"绝对对赌"},{"t_ms":228342,"text":"vivo官方不可能搞这种有损品牌形象的促销。"},{"t_ms":230547,"text":"舆论场最不讲的就是证据了"},{"t_ms":231891,"text":"银行都还有漫展摊位，办卡呢"},{"t_ms":232144,"text":"弹幕还在说vivo不可能啥的。我告诉你。他们常年这种走线下售卖的就这种模式。是所谓官方一定不知道你怎么卖，但是他们只管你卖出去就行。出了事不担责"},{"t_ms":234057,"text":"他们的缘由不需要去猜测或者推敲，跟这件事本身没有多大关系(即无论什么原因都不能这么做)"},{"t_ms":236885,"text":"这玩意也有省代吗？价格都相对透明的"},{"t_ms":239666,"text":"这也确实是蓝绿厂的方式嘛"},{"t_ms":242726,"text":"OPPO"},{"t_ms":245193,"text":"关键是也没和嘉宾提前商量,也没给利润分成,嘉宾肯定不乐意啊"},{"t_ms":245310,"text":"会不会是三大运营商？（三大运营商线上你搜一搜试一试是不是卖手机的）"},{"t_ms":249483,"text":"外包"},{"t_ms":249856,"text":"我想到了腾讯那年联动老干妈23333"},{"t_ms":251182,"text":"唯一难说者"},{"t_ms":252131,"text":"好奇压得什么宝"},{"t_ms":252564,"text":"舆论场，猜测既事实"},{"t_ms":252721,"text":"637工程"},{"t_ms":253311,"text":"甚至是某个亲戚的手机店"},{"t_ms":258263,"text":"给视频点赞需要购买溪木源吗"},{"t_ms":258671,"text":"溪木源这套男士好多男生在用"},{"t_ms":259107,"text":"好好好必须支持一波"},{"t_ms":260038,"text":"师傅别念了别念了 发发慈悲吧"},{"t_ms":260258,"text":"买一套溪木源才能给本视频点赞"},{"t_ms":260566,"text":"切入一点不生硬"},{"t_ms":261133,"text":"走了走了"},{"t_ms":262646,"text":"整段垮掉"},{"t_ms":264708,"text":"溪木源男士款做得挺用心"},{"t_ms":265333,"text":"是真的好用"},{"t_ms":278968,"text":"支持你一下"},{"t_ms":279367,"text":"买了三瓶，很好喝"},{"t_ms":280689,"text":"刚买完，早干啥去了"},{"t_ms":281950,"text":"是我会回购的产品"},{"t_ms":287835,"text":"用久了皮肤看着细一点"},{"t_ms":287882,"text":"B站几大赞助商之一2333333"},{"t_ms":291247,"text":"冲冲冲"},{"t_ms":292479,"text":"用完清清爽爽不闷"},{"t_ms":293561,"text":"这颜值可以啊"},{"t_ms":297183,"text":"买了三瓶，很好喝"},{"t_ms":297309,"text":"好用！还挺方便的"},{"t_ms":299167,"text":"她嫁人了"},{"t_ms":300587,"text":"你皮肤好多了"},{"t_ms":303378,"text":"真的吗"},{"t_ms":309848,"text":"控油还行脸没那么爱出油"},{"t_ms":310263,"text":"给我加急发货"},{"t_ms":312929,"text":"我一直都在用这个，肤质是有改善的"},{"t_ms":313409,"text":"刚好家里的用完了"},{"t_ms":315421,"text":"用起来步骤简单"},{"t_ms":317310,"text":"这不就是我们的老朋友嘛"},{"t_ms":320343,"text":"溪木源这套男士用着不错"},{"t_ms":326659,"text":"溪木源这套产品用着效果挺不错的"},{"t_ms":333464,"text":"水乳挺清爽的"},{"t_ms":333811,"text":"用一段时间皮肤细腻些"},{"t_ms":335248,"text":"99合一"},{"t_ms":337298,"text":"感觉UP主的脸确实好多了23333"},{"t_ms":339125,"text":"不然呢"},{"t_ms":339785,"text":"控油还能调节水油平衡，肌肤状态越来越好"},{"t_ms":340591,"text":"牌子挺靠谱的"},{"t_ms":347272,"text":"啊？洗脸不就是毛巾加水吗？还要什么？？？"},{"t_ms":350669,"text":"确实"},{"t_ms":354593,"text":"没事。我天黑再出门~"},{"t_ms":370364,"text":"熬夜打别的。。。。"},{"t_ms":373604,"text":"《热爱工作》"},{"t_ms":378035,"text":"哈哈大笑n"},{"t_ms":378932,"text":"17个小时吗"},{"t_ms":382621,"text":"白天打游戏导致只能晚上熬夜工作有没有懂得"},{"t_ms":384098,"text":"正常饮食作息解决99%的问题"},{"t_ms":394461,"text":"这个价位品牌套盒挺划算啊"},{"t_ms":399465,"text":"说谢谢吗？"},{"t_ms":401192,"text":"欢迎回来"},{"t_ms":402215,"text":"谢谢636"},{"t_ms":404724,"text":"可不，白天打游戏，晚上工作呗"},{"t_ms":405969,"text":"+"},{"t_ms":406340,"text":"636型潜艇在常规潜艇里面还是很不错的"},{"t_ms":406430,"text":"说谢谢了嘛"},{"t_ms":413799,"text":"啊是比心王来了"},{"t_ms":414143,"text":"握手券"},{"t_ms":415475,"text":"追星一个道理"},{"t_ms":415533,"text":"说起比心了是吧"},{"t_ms":417306,"text":"兔娘得提前一天晚上就开始排"},{"t_ms":419723,"text":"不愿意去，我就看他视频而已，去见他干什么，又没有足够时间谈话"},{"t_ms":422000,"text":"不愿意"},{"t_ms":422157,"text":"情绪价值"},{"t_ms":426608,"text":"不是这也不是颜值主播我见up干啥，，"},{"t_ms":428505,"text":"握手券嘛"},{"t_ms":431555,"text":"用自己的名誉给这纯主办方买单，谁能接受"},{"t_ms":433992,"text":"哈哈哈哈弹幕意见很统一啊"},{"t_ms":434742,"text":"兔娘的人设就是人民的兔娘"},{"t_ms":442646,"text":"兔娘的签售，按照兔娘的说法，还是比较实惠的"},{"t_ms":444123,"text":"哎呀  好想跟村霸握手啊"},{"t_ms":446134,"text":"兔娘的人设是人民的兔娘"},{"t_ms":447375,"text":"要和唯一讲述者比心拍照"},{"t_ms":451121,"text":"她不一样！"},{"t_ms":451901,"text":"她不一样！"},{"t_ms":452449,"text":"人设要立的住"},{"t_ms":454109,"text":"数值不达标"},{"t_ms":454254,"text":"哈哈哈哈话密了"}];

const TRUE_AD_START = 252.35;
const TRUE_AD_END = 397.86 + 0.3; // refine_edge('end') lands just after the last ad line

// ---- mocks ----
let jev_calls = [];
let jev_error_mode = null;     // 'hard' => every jev_call fails non-retryably
let jev_ad_mode = 'truth';     // 'truth' | 'all_ad' | 'short_ad'
let subtitle_mode = 'fixture'; // 'fixture' | 'none' | 'clean'
let ai_log_msgs = [];
const storage_data = {};
global.chrome = {
    runtime: {
        lastError: null,
        sendMessage: (msg, cb) => {
            if(msg.type === 'jev_ready') return cb({ready: true});
            if(msg.type === 'ai_log_append') { ai_log_msgs.push(msg.rec); return cb({ok: true}); }
            if(msg.type === 'bili_subtitle') {
                if(subtitle_mode === 'none') return cb({error: 'no subtitle for this video'});
                if(subtitle_mode === 'clean') return cb({error: null, lines: CLEAN_SUBTITLE});
                return cb({error: null, lines: FIXTURE_SUBTITLE});
            }
            if(msg.type === 'jev_call') {
                jev_calls.push(msg.body);
                setTimeout(() => {
                    if(jev_error_mode) return cb({error: jev_error_mode});
                    const answers = {};
                    const st = msg.body.state;
                    (st.windows || []).forEach((w, i) => {
                        // screening: p(ad) from ground-truth overlap with the window
                        const [lo, hi] = String(w.time_range_seconds).split('~').map(Number);
                        const frac = (Math.min(hi, 397.9) - Math.max(lo, 252.3)) / (hi - lo);
                        let p;
                        if(jev_ad_mode === 'all_ad')
                            p = 0.95; // dedicated sponsored video: everything reads as ad copy
                        else if(jev_ad_mode === 'short_ad')
                            p = w.w === 10 ? 0.9 : 0.05; // one coarse window, short read inside
                        else
                            p = frac >= 0.66 ? 0.9 : frac >= 0.15 ? 0.7 : 0.05;
                        answers['win_' + i] = {type: 'noul', noul: p};
                    });
                    (st.lines || []).forEach((l, i) => {
                        // boundary: p(ad) from whether the line is spoken inside the ad
                        let in_ad;
                        if(jev_ad_mode === 'all_ad')
                            in_ad = true;
                        else if(jev_ad_mode === 'short_ad')
                            in_ad = l.from_seconds >= 305 && l.from_seconds < 312; // ~7s read
                        else
                            in_ad = l.from_seconds >= TRUE_AD_START && l.from_seconds <= TRUE_AD_END - 0.5;
                        answers['line_' + i] = {type: 'noul', noul: in_ad ? 0.91 : 0.05};
                    });
                    cb({error: null, data: {answers, usage: {input_tokens: 900}}});
                }, 5);
            } else {
                cb(null);
            }
        },
    },
    storage: {
        local: {
            get: (k, cb) => {
                const r = {};
                if(typeof k === 'string')
                    r[k] = storage_data[k];
                else if(Array.isArray(k))
                    k.forEach(x => r[x] = storage_data[x]);
                else
                    Object.assign(r, storage_data);
                if(!cb) return Promise.resolve(r); // promise form (chrome MV3)
                setTimeout(() => cb(r), 0);
            },
            set: (obj, cb) => {
                Object.assign(storage_data, obj);
                if(!cb) return Promise.resolve(); // promise form (chrome MV3)
                cb();
            },
            remove: (k, cb) => {
                delete storage_data[k];
                if(!cb) return Promise.resolve(); // promise form (chrome MV3)
                cb();
            },
        },
    },
};
global.document = {
    title: '深扒vivo千万粉博主营销事件_哔哩哔哩_bilibili',
    querySelector: () => null, // no player host, no <video>: UI must stay silent, never crash
};
global.location = {pathname: '/video/BV17Neb6wE87/'};

// a "clean" video (no ad): plain chatter, nothing matching the pre-screen lexicon
const CLEAN_SUBTITLE = [
    {from: 0, to: 6, content: '今天我们来看看这颗新的传感器'},
    {from: 6, to: 14, content: '先说结论 白天的表现和上一代差不多'},
    {from: 14, to: 22, content: '夜景的进步主要来自算法'},
    {from: 22, to: 30, content: '我们一组一组来看样张'},
    {from: 30, to: 41, content: '第一组是白天顺光 场景相同参数相同'},
    {from: 41, to: 52, content: '两台的观感几乎没有区别'},
    {from: 52, to: 63, content: '放大之后边缘的解析力有些差异'},
    {from: 63, to: 75, content: '第二组是夜景 高光压制都做得不错'},
    {from: 75, to: 88, content: '但暗部的噪点处理思路完全不同'},
    {from: 88, to: 100, content: '最后总结一下这代的升级值不值'},
];
const CLEAN_DANMAKU = [
    {t_ms: 2000, text: '影像测评来了'},
    {t_ms: 9000, text: '传感器型号是多少'},
    {t_ms: 15000, text: '夜景样张等我'},
    {t_ms: 25000, text: '这组对比很明显'},
    {t_ms: 40000, text: '边缘解析力确实有差距'},
    {t_ms: 55000, text: '高光压制都不错'},
    {t_ms: 70000, text: '噪点这一组更自然'},
    {t_ms: 90000, text: '总结说得很中肯'},
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const assert = (cond, msg) => { if(!cond) { console.error('FAIL:', msg); process.exit(1); } };
const in_range = (x, lo, hi) => x >= lo && x <= hi;

const CFG = {AI_AD_SKIP: true, AI_AD_SKIP_AUTO: false, AI_AD_SKIP_AUTO_THRESHOLD: 0.9};

function to_objs(entries) {
    return entries.map(e => ({time_ms: e.t_ms, content: e.text}));
}

async function run_scan(cid, cfg, entries) {
    const ing = {type: 'proto_seg', cid: String(cid)};
    mod.ad_skip_on_ingress(ing, cfg);
    mod.ad_skip_feed_chunk(ing, {objs: to_objs(entries)});
    // re-fed range must be fully de-duplicated by ad_skip_feed_chunk
    mod.ad_skip_feed_chunk(ing, {objs: to_objs(entries.slice(0, Math.ceil(entries.length / 2)))});
    mod.ad_skip_begin_scan(ing, cfg);
    await mod.ad_skip_wait();
    return mod.ad_skip_debug_intervals();
}

(async () => {
    // ===== scenario 1: full flow — screening packs + boundary refinement =====
    let ivs = await run_scan(42027846013, CFG, FIXTURE_DANMAKU);
    console.log('scenario1: jev_calls=' + jev_calls.length
        + ' intervals=' + JSON.stringify(ivs.map(iv => [iv.start_s, iv.end_s, iv.conf])));
    const screen_reqs = jev_calls.filter(c => c.state.windows).length;
    const line_reqs = jev_calls.filter(c => c.state.lines).length;
    // windows 7..14 judged (signal windows + neighbors + <=2-window gap fill),
    // packed into 3 packs of <=90s; one interval => 2 boundary requests
    assert(screen_reqs === 3, '3 screening packs (got ' + screen_reqs + ')');
    assert(line_reqs === 2, '2 boundary refinement requests (got ' + line_reqs + ')');
    assert(ivs.length === 1, 'exactly one ad interval');
    assert(in_range(ivs[0].start_s, 248, 257), 'refined start near truth 252.35 (got ' + ivs[0].start_s + ')');
    assert(in_range(ivs[0].end_s, 394, 401), 'refined end near truth 398.16 (got ' + ivs[0].end_s + ')');
    assert(in_range(ivs[0].conf, 0.65, 0.75), 'confidence = min window p (got ' + ivs[0].conf + ')');
    assert(ivs[0].end_s - ivs[0].start_s >= 120, 'interval length >= 120s');
    // screening state carries the stats the criteria reference
    const w8 = jev_calls.find(c => c.state.windows).state.windows.find(w => w.w === 8);
    assert(w8 && w8.danmaku_sample.length > 0 && w8.subtitle_in_window.length > 0,
        'window state carries subtitle + de-duplicated danmaku sample');
    // boundary request context is the ad transcript slice
    const line_req = jev_calls.find(c => c.state.lines);
    assert(line_req && line_req.state.ad_context.length > 0, 'line request carries ad_context transcript');
    // scan summary landed in the diagnostic log
    const rec = ai_log_msgs.filter(r => r.type === 'ad_scan').pop();
    assert(rec && rec.windows_judged === 8 && rec.intervals.length === 1 && !rec.error,
        'ad_scan log record: 8 windows judged, 1 interval');
    // result cached per cid
    const cache = storage_data['ai_ad_intervals'] && storage_data['ai_ad_intervals']['42027846013'];
    assert(cache && cache.intervals.length === 1, 'interval cached for the cid');

    // ===== scenario 2: cached replay — zero new requests =====
    const calls_before = jev_calls.length;
    mod.ad_skip_on_ingress({type: 'proto_seg', cid: '999'}, CFG); // leaving the video resets state
    ivs = await run_scan(42027846013, CFG, FIXTURE_DANMAKU);
    console.log('scenario2: cached replay, new jev_calls=' + (jev_calls.length - calls_before));
    assert(jev_calls.length === calls_before, 'cache hit costs zero requests');
    assert(ivs.length === 1 && in_range(ivs[0].start_s, 248, 257), 'cached interval restored');

    // ===== scenario 3: no subtitle — danmaku-only degradation, no boundary requests =====
    subtitle_mode = 'none';
    const calls_before_3 = jev_calls.length;
    ivs = await run_scan(2222, CFG, FIXTURE_DANMAKU);
    console.log('scenario3: no subtitle, intervals=' + JSON.stringify(ivs.map(iv => [iv.start_s, iv.end_s])));
    assert(jev_calls.length - calls_before_3 === 3, 'screening only, no line refinement without subtitles');
    assert(ivs.length === 1, 'danmaku-only scan still finds the ad');
    assert(in_range(ivs[0].start_s, 210, 272), 'coarse/snapped start near the ad (got ' + ivs[0].start_s + ')');
    assert(in_range(ivs[0].end_s, 388, 450), 'coarse/snapped end near the ad (got ' + ivs[0].end_s + ')');
    assert(ivs[0].end_s - ivs[0].start_s >= 100, 'interval still spans the ad');

    // ===== scenario 4: clean video — zero Jev requests, zero intervals =====
    subtitle_mode = 'clean';
    const calls_before_4 = jev_calls.length;
    ivs = await run_scan(3333, CFG, CLEAN_DANMAKU);
    console.log('scenario4: clean video, new jev_calls=' + (jev_calls.length - calls_before_4)
        + ' intervals=' + ivs.length);
    assert(jev_calls.length === calls_before_4, 'no signals => nothing is sent to Jev');
    assert(ivs.length === 0, 'no interval on a clean video');

    // ===== scenario 5: Jev hard failure — fail-open, scan logs the error =====
    subtitle_mode = 'fixture';
    jev_error_mode = 'Jev API hard failure';
    ivs = await run_scan(4444, CFG, FIXTURE_DANMAKU);
    jev_error_mode = null;
    console.log('scenario5: jev hard failure, intervals=' + ivs.length);
    assert(ivs.length === 0, 'no interval on hard failure');
    const err_rec = ai_log_msgs.filter(r => r.type === 'ad_scan').pop();
    assert(err_rec && err_rec.error, 'failure recorded in the ad_scan log, scan promise resolved');

    // ===== scenario 6: auto-skip seeks the <video>; UI stays silent without a player host =====
    const fake_video = {currentTime: 300, closest: () => null, parentElement: null};
    global.document = {
        title: global.document.title,
        querySelector: (sel) => sel === 'video' ? fake_video : null,
    };
    const CFG_AUTO = {AI_AD_SKIP: true, AI_AD_SKIP_AUTO: true, AI_AD_SKIP_AUTO_THRESHOLD: 0.65};
    ivs = await run_scan(5555, CFG_AUTO, FIXTURE_DANMAKU);
    await sleep(1300); // ui watcher ticks every 500ms
    console.log('scenario6: auto-skip, video.currentTime=' + fake_video.currentTime.toFixed(1)
        + ' (ad end ' + ivs[0].end_s.toFixed(1) + ')');
    assert(ivs.length === 1 && ivs[0].conf >= 0.65, 'interval above the auto threshold');
    assert(Math.abs(fake_video.currentTime - ivs[0].end_s) < 0.05,
        'auto-skip seeked the video to the ad end');
    // manual-threshold interplay: same interval, threshold above confidence => no auto skip
    const fake_video2 = {currentTime: 300, closest: () => null, parentElement: null};
    global.document.querySelector = (sel) => sel === 'video' ? fake_video2 : null;
    const CFG_HI = {AI_AD_SKIP: true, AI_AD_SKIP_AUTO: true, AI_AD_SKIP_AUTO_THRESHOLD: 0.95};
    ivs = await run_scan(6666, CFG_HI, FIXTURE_DANMAKU);
    await sleep(1300);
    console.log('scenario6b: threshold above confidence, video.currentTime=' + fake_video2.currentTime);
    assert(fake_video2.currentTime === 300, 'below-threshold interval does not auto-skip');

    // ===== scenario 7: ads cover most of the video => promotion IS the content =====
    jev_ad_mode = 'all_ad';
    const calls_before_7 = jev_calls.length;
    ivs = await run_scan(7777, {...CFG, AI_AD_SKIP_MAX_COVER: 0.4}, FIXTURE_DANMAKU);
    jev_ad_mode = 'truth';
    console.log('scenario7: coverage suppression, intervals=' + ivs.length);
    assert(jev_calls.length - calls_before_7 >= 3, 'screening still ran before the coverage verdict');
    assert(ivs.length === 0, 'near-full-video coverage is treated as content, not an inserted ad');
    const cov_rec = ai_log_msgs.filter(r => r.type === 'ad_scan' && r.cid === 7777).pop();
    assert(cov_rec && cov_rec.suppressed === 'coverage' && cov_rec.covered_ratio >= 0.4,
        'suppression reason and covered ratio logged for diagnosis');

    // ===== scenario 8: refined read shorter than AI_AD_SKIP_MIN_S => dropped =====
    jev_ad_mode = 'short_ad';
    ivs = await run_scan(8888, CFG, FIXTURE_DANMAKU);
    jev_ad_mode = 'truth';
    console.log('scenario8: short read, intervals=' + JSON.stringify(ivs));
    assert(ivs.length === 0, 'reads shorter than the minimum duration are not worth a cut');
    const short_rec = ai_log_msgs.filter(r => r.type === 'ad_scan' && r.cid === 8888).pop();
    assert(short_rec && short_rec.windows_judged === 8 && short_rec.intervals.length === 0
        && short_rec.suppressed !== 'coverage',
        'short read was judged and dropped by the duration filter, not the coverage guard');

    // ===== scenario 9: AI_AD_SKIP_CACHE off — stored entry ignored, nothing persisted =====
    mod.ad_skip_on_ingress({type: 'proto_seg', cid: '999'}, CFG); // leaving the video resets state
    const CFG_NOCACHE = {...CFG, AI_AD_SKIP_CACHE: false};
    const calls_before_9 = jev_calls.length;
    ivs = await run_scan(42027846013, CFG_NOCACHE, FIXTURE_DANMAKU); // cid cached back in scenario 1
    console.log('scenario9: cache off over a cached cid, new jev_calls=' + (jev_calls.length - calls_before_9));
    assert(jev_calls.length - calls_before_9 === 5, 'a stored entry is ignored, the full scan re-runs');
    assert(ivs.length === 1 && in_range(ivs[0].start_s, 248, 257), 'the rescan still finds the ad');
    // a fresh cid scanned with the cache off must not land in storage
    ivs = await run_scan(1212, CFG_NOCACHE, FIXTURE_DANMAKU);
    assert(ivs.length === 1, 'fresh cid scanned');
    assert(!storage_data['ai_ad_intervals'] || !storage_data['ai_ad_intervals']['1212'],
        'nothing persisted for a cid scanned with the cache off');
    console.log('scenario9b: fresh cid, cache off, no storage entry');

    // ===== scenario 10: prompt lead window / ✕ dismiss / hang TTL / notice duration =====
    // minimal DOM mock: real elements are not needed, only the shapes ui_tick
    // touches (pill/notice creation, host appendChild, click listeners)
    function make_dom_mock() {
        const host = {style: {}, children: [], appendChild(c) { this.children.push(c); }};
        const video = {currentTime: 0, parentElement: host, closest: () => null};
        global.document = {
            title: global.document.title,
            querySelector: sel => sel === 'video' ? video : null,
            createElement: () => {
                const el = {
                    id: '', style: {}, _html: '', _subs: {},
                    set innerHTML(h) { this._html = h; },
                    get innerHTML() { return this._html; },
                    querySelector(sel) {
                        if(!this._subs[sel]) {
                            const sub = {listeners: {}, addEventListener(ev, fn) { this.listeners[ev] = fn; }};
                            this._subs[sel] = sub;
                        }
                        return this._subs[sel];
                    },
                    addEventListener(ev, fn) { this.listeners = this.listeners || {}; this.listeners[ev] = fn; },
                    appendChild(c) { this.children = this.children || []; this.children.push(c); },
                    remove() {
                        this._removed = true;
                        const i = host.children.indexOf(this);
                        if(i >= 0) host.children.splice(i, 1);
                    },
                };
                return el;
            },
        };
        global.getComputedStyle = () => ({position: 'static'});
        const by_id = want => host.children.find(e => e.id === want);
        return {host, video, pill: () => by_id('pakku-ad-skip'), notice: () => by_id('pakku-ad-skip-notice')};
    }

    // (a-c) lead window + ✕ dismiss (long TTL so only the ✕ path can hide it)
    const dom = make_dom_mock();
    const CFG_UI = {AI_AD_SKIP: true, AI_AD_SKIP_AUTO: false, AI_AD_SKIP_PROMPT_LEAD_S: 5,
        AI_AD_SKIP_PROMPT_TTL_S: 60, AI_AD_SKIP_NOTE_S: 2};
    dom.video.currentTime = 252.35 - 6; // before the lead window opens
    await run_scan(10101, CFG_UI, FIXTURE_DANMAKU);
    await sleep(1300);
    assert(!dom.pill(), 'no prompt before the lead window opens');
    dom.video.currentTime = 252.35 - 4; // inside the lead window
    await sleep(1300);
    assert(dom.pill(), 'prompt appears inside the lead window');
    assert(dom.pill()._html.includes('pakku-ad-close'), 'prompt carries the ✕ close button');
    dom.pill()._subs['button.pakku-ad-close'].listeners.click();
    await sleep(600);
    assert(!dom.pill(), '✕ removes the prompt');
    dom.video.currentTime = 300; // inside the ad itself
    await sleep(1300);
    assert(!dom.pill(), 'a dismissed interval never prompts again this visit');
    console.log('scenario10a-c: lead window opens at start-5, ✕ dismisses for the visit');

    // (d) hang TTL auto-dismisses (short TTL, nobody clicks anything)
    const dom2 = make_dom_mock();
    dom2.video.currentTime = 252.35 - 4;
    await run_scan(20202, {...CFG_UI, AI_AD_SKIP_PROMPT_TTL_S: 2}, FIXTURE_DANMAKU);
    await sleep(1000);
    assert(dom2.pill(), 'prompt appears with the short TTL');
    await sleep(3000); // ttl 2s + tick margin
    assert(!dom2.pill(), 'prompt auto-dismisses after hanging for the TTL');
    dom2.video.currentTime = 300;
    await sleep(1300);
    assert(!dom2.pill(), 'timed-out interval does not prompt again');
    console.log('scenario10d: TTL auto-dismiss');

    // (e) manual skip: notice shows for AI_AD_SKIP_NOTE_S, then disappears
    const dom3 = make_dom_mock();
    dom3.video.currentTime = 300;
    await run_scan(30303, CFG_UI, FIXTURE_DANMAKU);
    await sleep(1300);
    assert(dom3.pill(), 'prompt appears inside the ad');
    dom3.pill()._subs['button'].listeners.click(); // 跳过广告
    await sleep(300);
    assert(!dom3.pill(), 'skip removes the prompt');
    assert(dom3.notice(), 'post-skip notice appears');
    assert(Math.abs(dom3.video.currentTime - 398.16) < 0.05, 'skip seeked to the ad end');
    await sleep(1000);
    assert(dom3.notice(), 'notice still up before the note duration elapses');
    await sleep(2500); // note_s 2s + margin
    assert(!dom3.notice(), 'notice hides after AI_AD_SKIP_NOTE_S seconds');
    console.log('scenario10e: skip notice duration');

    // (f) the 回到 undo link seeks back to the ad start
    const dom4 = make_dom_mock();
    dom4.video.currentTime = 300;
    await run_scan(40404, CFG_UI, FIXTURE_DANMAKU);
    await sleep(1300);
    dom4.pill()._subs['button'].listeners.click();
    await sleep(300);
    assert(dom4.notice(), 'notice appears for the undo test');
    dom4.notice()._subs['a'].listeners.click();
    assert(Math.abs(dom4.video.currentTime - 252.35) < 0.05, '回到 seeks back to the ad start');
    assert(!dom4.notice(), 'undo hides the notice');
    console.log('scenario10f: undo link');

    console.log('ALL PASS');
    process.exit(0); // the ui watcher interval would keep the process alive
})().catch(e => { console.error('FAIL: unhandled', e); process.exit(1); });

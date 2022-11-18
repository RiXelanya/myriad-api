import {AuthenticationComponent} from '@loopback/authentication';
import {BootMixin} from '@loopback/boot';
import {ApplicationConfig, createBindingFromClass} from '@loopback/core';
import {HealthComponent} from '@loopback/health';
import {
  AnyObject,
  RepositoryMixin,
  SchemaMigrationOptions,
} from '@loopback/repository';
import {RestApplication, Request, Response} from '@loopback/rest';
import {RestExplorerComponent} from '@loopback/rest-explorer';
import {ServiceMixin} from '@loopback/service-proxy';
import * as firebaseAdmin from 'firebase-admin';
import {config} from './config';
import path from 'path';
import {JWTAuthenticationComponent} from './components';
import {MyriadSequence} from './sequence';
import {
  CurrencyService,
  ExperienceService,
  FCMService,
  FriendService,
  MetricService,
  NotificationService,
  PostService,
  ReportService,
  SocialMediaService,
  TagService,
  TransactionService,
  UserSocialMediaService,
  ActivityLogService,
  VoteService,
  NetworkService,
  ServerService,
} from './services';
import {UpdatePeopleProfileJob} from './jobs';
import {CronComponent} from '@loopback/cron';
import * as Sentry from '@sentry/node';
import multer from 'multer';
import {v4 as uuid} from 'uuid';
import {FILE_UPLOAD_SERVICE} from './keys';
import {
  AccountSettingRepository,
  ActivityLogRepository,
  CommentRepository,
  CurrencyRepository,
  DraftPostRepository,
  ExperienceRepository,
  ExperienceUserRepository,
  FriendRepository,
  LanguageSettingRepository,
  NetworkRepository,
  NotificationRepository,
  NotificationSettingRepository,
  PeopleRepository,
  PostRepository,
  ReportRepository,
  ServerRepository,
  TagRepository,
  TransactionRepository,
  UserCurrencyRepository,
  UserExperienceRepository,
  UserReportRepository,
  UserRepository,
  UserSocialMediaRepository,
  VoteRepository,
  WalletRepository,
} from './repositories';
import {
  RateLimiterComponent,
  RateLimitSecurityBindings,
} from 'loopback4-ratelimiter';
import {getFilePathFromSeedData, upload} from './utils/upload';
import {DateUtils} from './utils/date-utils';
import fs, {existsSync} from 'fs';
import {FriendStatusType, UploadType} from './enums';
import {omit} from 'lodash';
import {PolkadotJs} from './utils/polkadotJs-utils';
import {EmailService} from './services/email.service';
import {UserService} from './services/user.service';

const date = new DateUtils();
const jwt = require('jsonwebtoken');

export {ApplicationConfig};

/* eslint-disable  @typescript-eslint/naming-convention */
export class MyriadApiApplication extends BootMixin(
  ServiceMixin(RepositoryMixin(RestApplication)),
) {
  constructor(options: ApplicationConfig = {}) {
    super(options);

    // Set up default home page
    this.static('/', path.join(__dirname, '../public'));
    // Set up local storages
    this.static('/storages', path.join(__dirname, '../storages'));
    // Set up the custom sequence
    this.sequence(MyriadSequence);
    this.configureFileUpload();
    this.configureFirebase();
    this.configureSentry();
    // Register component
    this.registerComponent();
    // Register services
    this.registerService();
    // Register job
    this.registerJob();

    this.projectRoot = __dirname;
  }

  registerComponent() {
    this.component(HealthComponent);
    this.component(CronComponent);
    this.component(AuthenticationComponent);
    this.component(JWTAuthenticationComponent);
    this.component(RestExplorerComponent);

    if (this.options.test) return;
    if (config.REDIS_CONNECTOR !== 'kv-redis') return;

    this.component(RateLimiterComponent);
    this.bind(RateLimitSecurityBindings.CONFIG).to({
      name: 'redis',
      type: 'RedisStore',
      windowMs: 15 * date.minute,
      standardHeaders: true,
      max: (req: Request, _: Response) => {
        switch (req.method) {
          case 'GET':
            return 900;

          case 'POST':
            return 50;

          case 'PATCH':
            return 50;

          case 'DELETE':
            return 50;

          default:
            return 900;
        }
      },
      keyGenerator: (req: Request, _: Response) => {
        const token = req.headers?.authorization?.replace(/bearer /i, '');
        const decryptedToken = token
          ? jwt.verify(token, config.JWT_TOKEN_SECRET_KEY)
          : undefined;
        const keyId = decryptedToken?.id ?? req.ip;
        const key = `${req.method}${req.path}/${keyId}`;

        return key;
      },
      handler: (_: Request, res: Response) => {
        res.status(429).send({
          error: {
            statusCode: 429,
            name: 'TooManyRequestsError',
            message: 'Too many request, please try again later',
          },
        });
      },
      skipFailedRequests: true,
    });
  }

  registerService() {
    this.service(NotificationService);
    this.service(FriendService);
    this.service(UserSocialMediaService);
    this.service(TransactionService);
    this.service(SocialMediaService);
    this.service(CurrencyService);
    this.service(ReportService);
    this.service(PostService);
    this.service(TagService);
    this.service(ExperienceService);
    this.service(MetricService);
    this.service(ActivityLogService);
    this.service(VoteService);
    this.service(NetworkService);
    this.service(ServerService);
    this.service(EmailService);
    this.service(UserService);

    // 3rd party service
    this.service(FCMService);
  }

  registerJob() {
    this.add(createBindingFromClass(UpdatePeopleProfileJob));
  }

  configureFileUpload() {
    if (this.options.test) return;
    const multerOptions: multer.Options = {
      storage: multer.diskStorage({
        filename: (_, file, cb) => {
          cb(null, `${uuid()}${path.extname(file.originalname)}`);
        },
      }),
    };
    // Configure the file upload service with multer options
    this.configure(FILE_UPLOAD_SERVICE).to(multerOptions);
  }

  configureFirebase() {
    if (this.options.test || !config.FIREBASE_STORAGE_BUCKET) return;
    firebaseAdmin.initializeApp({
      storageBucket: config.FIREBASE_STORAGE_BUCKET,
    });
  }

  configureSentry() {
    if (this.options.test || !config.SENTRY_DSN) return;
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 1.0,
    });
  }

  async migrateSchema(options?: SchemaMigrationOptions): Promise<void> {
    await super.migrateSchema(options);

    if (options?.existingSchema === 'drop') return this.databaseSeeding();
    await Promise.allSettled([this.doMigrateTransaction()]);
  }

  async databaseSeeding(): Promise<void> {
    const directory = path.join(__dirname, '../seed-data');

    if (!existsSync(directory)) return;

    const {
      currencyRepository,
      friendRepository,
      networkRepository,
      serverRepository,
      userRepository,
      userCurrencyRepository,
      walletRepository,
    } = await this.repositories();

    const bar = this.initializeProgressBar('Start Seeding');
    const files = fs.readdirSync(directory);

    bar.start(files.length - 1, 0);
    for (const [index, file] of files.entries()) {
      if (file.endsWith('.json')) {
        const dataDirectory = path.join(directory, file);
        const stringifyJSON = fs.readFileSync(dataDirectory, 'utf-8');
        const data = JSON.parse(stringifyJSON);

        switch (file) {
          case 'network-currencies.json':
          case 'default-network-currencies.json': {
            await Promise.all(
              data.map(async (networkCurrency: AnyObject) => {
                const {network, currencies} = networkCurrency;
                const filePath = getFilePathFromSeedData(
                  network.sourceImageFileName,
                );
                const targetDir = `${network.targetImagePath}/${network.id}`;
                const networkImageURL = await upload(
                  UploadType.IMAGE,
                  targetDir,
                  filePath,
                );

                if (!networkImageURL) return;

                const rawNetwork = Object.assign(
                  omit(network, ['targetImagePath', 'sourceImageFileName']),
                  {
                    image: networkImageURL,
                  },
                );

                const updatedCurrencies = await Promise.all(
                  currencies.map(async (currency: AnyObject) => {
                    const sourceImageFileName = currency.sourceImageFileName;
                    const currencyFilePath =
                      getFilePathFromSeedData(sourceImageFileName);
                    const currencyTargetDir = `${currency.targetImagePath}/${currency.name}`;
                    const currencyImageURL = await upload(
                      UploadType.IMAGE,
                      currencyTargetDir,
                      currencyFilePath,
                    );

                    if (!currencyImageURL) return;

                    return Object.assign(
                      omit(currency, [
                        'targetImagePath',
                        'sourceImageFileName',
                      ]),
                      {
                        image: currencyImageURL,
                        networkId: rawNetwork.id,
                      },
                    );
                  }),
                );

                const rawCurrencies = updatedCurrencies.filter(
                  e => e !== undefined,
                );

                if (currencies.length === 0) return;

                await currencyRepository.createAll(rawCurrencies);
                await networkRepository.create(rawNetwork);
              }),
            );
            break;
          }

          case 'user-wallet.json':
          case 'default-user-wallet.json': {
            const wallets = await Promise.all(
              data.map(async (e: AnyObject) => {
                const {user, wallet} = e;
                const rawUser = omit(user, [
                  'sourceImageFileName',
                  'targetImagePath',
                ]);

                if (user.username === 'myriad_official') {
                  Object.assign(rawUser, {
                    verified: true,
                    bio: 'A social metaverse & metasocial network on web3, pulling content from mainstream social media and turning every post into a tipping wallet.',
                    websiteURL: 'https://myriad.social',
                  });
                }

                const {id} = await userRepository.create(rawUser);
                const filePath = getFilePathFromSeedData(
                  user.sourceImageFileName,
                );
                const targetDir = `users/${id}/image`;
                const profilePictureURL = await upload(
                  UploadType.IMAGE,
                  targetDir,
                  filePath,
                );

                await userRepository.updateById(id, {profilePictureURL});

                Object.assign(wallet, {primary: true});

                return userRepository.wallets(id).create(wallet);
              }),
            );

            const myriadWallet = wallets.find(e => {
              return (
                e.id ===
                '0xecfeabd53afba60983271c8fc13c133ae7e904ba90a7c5dee1f43523559fee5f'
              );
            });
            const promises = [];
            for (const wallet of wallets) {
              const userId = wallet.userId;
              const networkId = wallet.networkId;
              const [exists, currencies] = await Promise.all([
                networkRepository.exists(networkId),
                currencyRepository.find({
                  where: {networkId},
                  order: ['native DESC'],
                }),
              ]);

              if (currencies.length === 0 || !exists) {
                await Promise.all([
                  userRepository.deleteAll(),
                  currencyRepository.deleteAll(),
                  walletRepository.deleteAll(),
                  serverRepository.deleteAll(),
                ]);

                throw new Error('Currency/Network Not Found');
              }

              if (myriadWallet && userId !== myriadWallet.userId) {
                promises.push(
                  friendRepository.create({
                    status: FriendStatusType.APPROVED,
                    requestorId: userId,
                    requesteeId: myriadWallet.userId,
                  }),
                );
              }

              promises.push(
                userRepository.accountSetting(userId).create({}),
                userRepository.notificationSetting(userId).create({}),
                userRepository.languageSetting(userId).create({}),
                currencies.map((currency: AnyObject, idx: number) =>
                  userCurrencyRepository.create({
                    currencyId: currency.id,
                    networkId,
                    userId,
                    priority: idx + 1,
                  }),
                ),
              );
            }

            await Promise.allSettled(promises);

            break;
          }

          case 'server.json': {
            const mnemonic = config.MYRIAD_ADMIN_MNEMONIC;

            if (!mnemonic) throw new Error('MnemonicNotFound');

            const {getKeyring} = new PolkadotJs();
            const serverAdmin = getKeyring().addFromMnemonic(mnemonic);
            const address = serverAdmin.address;
            const filePathProfile = getFilePathFromSeedData(
              data.sourceImageFileName,
            );
            const filePathBanner = getFilePathFromSeedData(
              data.images.sourceImageFileName,
            );
            const targetDirProfile = data.targetImagePath;
            const targetDirBanner = data.images.targetImagePath;
            const [serverImageURL, logoBannerURL] = await Promise.all([
              upload(UploadType.IMAGE, targetDirProfile, filePathProfile),
              upload(UploadType.IMAGE, targetDirBanner, filePathBanner),
            ]);

            if (!serverImageURL || !logoBannerURL) {
              await Promise.all([
                userRepository.deleteAll(),
                currencyRepository.deleteAll(),
                walletRepository.deleteAll(),
                serverRepository.deleteAll(),
              ]);

              throw new Error('Image server not exists');
            }

            const serverName =
              data.name === 'Instance'
                ? `${data.name} ${Math.floor(Math.random() * 1000)}`
                : data.name;

            const rawServer = Object.assign(
              omit(data, ['sourceImageFileName', 'targetImagePath']),
              {
                name: serverName,
                serverImageURL: serverImageURL,
                accountId: {
                  myriad: address,
                },
                images: {
                  logo_banner: logoBannerURL,
                },
              },
            );

            await serverRepository.create(rawServer);
            break;
          }

          default:
            return;
        }
      }

      bar.update(index);
    }

    bar.stop();
  }

  async doMigrateTransaction(): Promise<void> {
    const {transactionRepository, walletRepository} = await this.repositories();
    const {count: totalTransaction} = await transactionRepository.count();
    const bar = this.initializeProgressBar('Start Migrate Transaction');
    const promises = [];

    bar.start(totalTransaction - 1, 0);
    for (let i = 0; i < totalTransaction; i++) {
      const [transaction] = await transactionRepository.find({
        limit: 1,
        skip: i,
      });

      if (!transaction) continue;
      const {from, to} = transaction;
      const [fromWallet, toWallet] = await Promise.all([
        walletRepository.findOne({where: {id: from}}),
        walletRepository.findOne({where: {id: to}}),
      ]);

      const updatedTransaction = {};

      if (fromWallet) {
        Object.assign(updatedTransaction, {from: fromWallet.userId});
      }

      if (toWallet) {
        Object.assign(updatedTransaction, {to: toWallet.userId});
      }

      promises.push(
        transactionRepository.updateById(transaction.id, updatedTransaction),
      );

      bar.update(i);
    }

    await Promise.allSettled(promises);

    bar.stop();
  }

  async repositories(): Promise<Repositories> {
    const accountSettingRepository = await this.getRepository(
      AccountSettingRepository,
    );
    const activityLogRepository = await this.getRepository(
      ActivityLogRepository,
    );
    const commentRepository = await this.getRepository(CommentRepository);
    const currencyRepository = await this.getRepository(CurrencyRepository);
    const draftPostRepository = await this.getRepository(DraftPostRepository);
    const experienceUserRepository = await this.getRepository(
      ExperienceUserRepository,
    );
    const experienceRepository = await this.getRepository(ExperienceRepository);
    const friendRepository = await this.getRepository(FriendRepository);
    const languageSettingRepository = await this.getRepository(
      LanguageSettingRepository,
    );
    const networkRepository = await this.getRepository(NetworkRepository);
    const notificationRepository = await this.getRepository(
      NotificationRepository,
    );
    const notificationSettingRepository = await this.getRepository(
      NotificationSettingRepository,
    );
    const peopleRepository = await this.getRepository(PeopleRepository);
    const postRepository = await this.getRepository(PostRepository);
    const reportRepository = await this.getRepository(ReportRepository);
    const serverRepository = await this.getRepository(ServerRepository);
    const tagRepository = await this.getRepository(TagRepository);
    const transactionRepository = await this.getRepository(
      TransactionRepository,
    );
    const userRepository = await this.getRepository(UserRepository);
    const userCurrencyRepository = await this.getRepository(
      UserCurrencyRepository,
    );
    const userExperienceRepository = await this.getRepository(
      UserExperienceRepository,
    );
    const userReportRepository = await this.getRepository(UserReportRepository);
    const userSocMedRepository = await this.getRepository(
      UserSocialMediaRepository,
    );
    const voteRepository = await this.getRepository(VoteRepository);
    const walletRepository = await this.getRepository(WalletRepository);

    return {
      accountSettingRepository,
      activityLogRepository,
      commentRepository,
      currencyRepository,
      draftPostRepository,
      experienceUserRepository,
      experienceRepository,
      friendRepository,
      languageSettingRepository,
      networkRepository,
      notificationRepository,
      notificationSettingRepository,
      peopleRepository,
      postRepository,
      reportRepository,
      serverRepository,
      tagRepository,
      transactionRepository,
      userRepository,
      userCurrencyRepository,
      userExperienceRepository,
      userReportRepository,
      userSocMedRepository,
      voteRepository,
      walletRepository,
    };
  }

  initializeProgressBar(title: string) {
    const cliProgress = require('cli-progress');
    const colors = require('ansi-colors');

    return new cliProgress.Bar({
      format:
        `${title} |` +
        colors.cyan('{bar}') +
        '| {percentage}% || ETA: {eta}s || {value}/{total} documents ',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
      synchronousUpdate: true,
    });
  }
}

interface Repositories {
  accountSettingRepository: AccountSettingRepository;
  activityLogRepository: ActivityLogRepository;
  commentRepository: CommentRepository;
  currencyRepository: CurrencyRepository;
  draftPostRepository: DraftPostRepository;
  experienceUserRepository: ExperienceUserRepository;
  experienceRepository: ExperienceRepository;
  friendRepository: FriendRepository;
  languageSettingRepository: LanguageSettingRepository;
  networkRepository: NetworkRepository;
  notificationRepository: NotificationRepository;
  notificationSettingRepository: NotificationSettingRepository;
  peopleRepository: PeopleRepository;
  postRepository: PostRepository;
  reportRepository: ReportRepository;
  serverRepository: ServerRepository;
  tagRepository: TagRepository;
  transactionRepository: TransactionRepository;
  userRepository: UserRepository;
  userCurrencyRepository: UserCurrencyRepository;
  userExperienceRepository: UserExperienceRepository;
  userReportRepository: UserReportRepository;
  userSocMedRepository: UserSocialMediaRepository;
  voteRepository: VoteRepository;
  walletRepository: WalletRepository;
}
